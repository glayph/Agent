/**
 * Regression tests for the channel/session concurrency fix.
 *
 * Every channel adapter (Telegram, Discord, WhatsApp, Slack, Feishu,
 * DingTalk, Line, QQ, Matrix, IRC, MQTT, OneBot) and the scheduler
 * ultimately call `orchestrator.runAgentLoop(sessionId, message)` with no
 * synchronization of their own. Before this fix, two turns for the same
 * sessionId (e.g. a scheduled task mid-run and an incoming channel message
 * on the now-universal session) could start concurrently and interleave
 * against the same shared `_messageHistory` entry. `collectAgentResponse`
 * now serializes same-session turns via `sessionTurnLock` while still
 * letting different sessions run independently.
 */

import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  isChattyModeEnabled,
  splitForChattyMode,
  splitOutboundMessage,
  splitOutboundMessageForOrchestrator,
} from "./agent-response.js";
import { sessionTurnLock } from "../session-turn-lock.js";

/**
 * A minimal orchestrator stand-in whose `runAgentLoop` records concurrency
 * (how many calls are in-flight at once, and the start/end order) instead
 * of doing anything with an LLM.
 */
function makeTrackingOrchestrator(
  events: string[],
  maxConcurrentRef: {
    current: number;
    max: number;
  },
) {
  return {
    async *runAgentLoop(sessionId: string, message: string) {
      maxConcurrentRef.current++;
      maxConcurrentRef.max = Math.max(
        maxConcurrentRef.max,
        maxConcurrentRef.current,
      );
      events.push(`${sessionId}:${message}:start`);
      // Yield across a real microtask/timer boundary so overlapping calls
      // actually have a chance to interleave if unsynchronized.
      await new Promise((r) => setTimeout(r, 10));
      events.push(`${sessionId}:${message}:end`);
      maxConcurrentRef.current--;
      yield JSON.stringify({ type: "final", content: `${message}-reply` });
    },
  } as unknown as AgentOrchestrator;
}

describe("collectAgentResponse session concurrency", () => {
  it("serializes two turns for the same sessionId instead of interleaving", async () => {
    const events: string[] = [];
    const concurrency = { current: 0, max: 0 };
    const orchestrator = makeTrackingOrchestrator(events, concurrency);
    const sessionId = `test-same-${Date.now()}`;

    const [replyA, replyB] = await Promise.all([
      collectAgentResponse(orchestrator, sessionId, "A"),
      collectAgentResponse(orchestrator, sessionId, "B"),
    ]);

    expect(concurrency.max).toBe(1);
    // One turn must fully start and end before the other starts.
    const startA = events.indexOf(`${sessionId}:A:start`);
    const endA = events.indexOf(`${sessionId}:A:end`);
    const startB = events.indexOf(`${sessionId}:B:start`);
    const endB = events.indexOf(`${sessionId}:B:end`);
    expect(Math.max(startA, startB)).toBeGreaterThan(Math.min(endA, endB));
    expect(replyA).toBe("A-reply");
    expect(replyB).toBe("B-reply");
  });

  it("does not serialize turns for different sessionIds", async () => {
    const events: string[] = [];
    const concurrency = { current: 0, max: 0 };
    const orchestrator = makeTrackingOrchestrator(events, concurrency);

    await Promise.all([
      collectAgentResponse(orchestrator, "session-x", "A"),
      collectAgentResponse(orchestrator, "session-y", "B"),
    ]);

    expect(concurrency.max).toBe(2);
  });

  it("releases the lock even if runAgentLoop throws", async () => {
    const sessionId = `test-throw-${Date.now()}`;
    const throwingOrchestrator = {
      async *runAgentLoop(): AsyncGenerator<string, void, unknown> {
        throw new Error("boom");
      },
    } as unknown as AgentOrchestrator;

    await expect(
      collectAgentResponse(throwingOrchestrator, sessionId, "hi"),
    ).rejects.toThrow("boom");

    // Lock must not be left held - a following call for the same session
    // must be able to proceed immediately.
    expect(sessionTurnLock.isLocked(sessionId)).toBe(false);
  });
});

/**
 * Regression tests for "Chatty Mode" (config: agents.defaults.split_on_marker).
 * Previously this toggle saved to config but had no runtime effect on any
 * channel adapter (dead toggle) - see problem #48. It is now wired through
 * splitOutboundMessageForOrchestrator, which every channel adapter calls to
 * build its outbound reply parts.
 */
function makeOrchestratorWithConfig(config: unknown): AgentOrchestrator {
  return { config } as unknown as AgentOrchestrator;
}

describe("isChattyModeEnabled", () => {
  it("is false when split_on_marker is absent from config", () => {
    expect(isChattyModeEnabled(makeOrchestratorWithConfig({}))).toBe(false);
  });

  it("is false when agents.defaults is missing entirely", () => {
    expect(
      isChattyModeEnabled(makeOrchestratorWithConfig({ agents: {} })),
    ).toBe(false);
  });

  it("is false when split_on_marker is explicitly false", () => {
    const config = { agents: { defaults: { split_on_marker: false } } };
    expect(isChattyModeEnabled(makeOrchestratorWithConfig(config))).toBe(false);
  });

  it("is true when split_on_marker is true", () => {
    const config = { agents: { defaults: { split_on_marker: true } } };
    expect(isChattyModeEnabled(makeOrchestratorWithConfig(config))).toBe(true);
  });

  it("does not throw on malformed config shapes", () => {
    expect(() =>
      isChattyModeEnabled(makeOrchestratorWithConfig(null)),
    ).not.toThrow();
    expect(() =>
      isChattyModeEnabled(makeOrchestratorWithConfig({ agents: "oops" })),
    ).not.toThrow();
  });
});

describe("splitForChattyMode", () => {
  it("returns an empty array for empty/whitespace-only text", () => {
    expect(splitForChattyMode("")).toEqual([]);
    expect(splitForChattyMode("   \n\n  ")).toEqual([]);
  });

  it("keeps a single short message as one bubble", () => {
    expect(splitForChattyMode("Hey, how's it going?")).toEqual([
      "Hey, how's it going?",
    ]);
  });

  it("splits on paragraph breaks", () => {
    const text = "First thought here.\n\nSecond thought here.";
    expect(splitForChattyMode(text)).toEqual([
      "First thought here.",
      "Second thought here.",
    ]);
  });

  it("packs sentences of a long paragraph into multiple short bubbles", () => {
    const sentence = "This is one reasonably short sentence.";
    const paragraph = Array(10).fill(sentence).join(" ");
    const bubbles = splitForChattyMode(paragraph);

    expect(bubbles.length).toBeGreaterThan(1);
    for (const bubble of bubbles) {
      expect(bubble.length).toBeLessThanOrEqual(260);
    }
    // No sentence content should be lost or duplicated.
    expect(bubbles.join(" ")).toContain(sentence);
  });

  it("does not leave a very short trailing fragment as its own bubble", () => {
    const paragraph =
      "This is a reasonably long first sentence to fill space. " +
      "Here is another one that also takes up a good bit of room. " +
      "Ok.";
    const bubbles = splitForChattyMode(paragraph);
    expect(bubbles[bubbles.length - 1].length).toBeGreaterThan(3);
    expect(bubbles.every((b) => b.trim().length > 0)).toBe(true);
  });

  it("never drops text content across bubbles", () => {
    const text =
      "Paragraph one has some words.\n\n" +
      "Paragraph two also has some words, and it keeps going a fair bit longer than the first one did.";
    const bubbles = splitForChattyMode(text);
    const rejoined = bubbles.join(" ");
    expect(rejoined).toContain("Paragraph one has some words.");
    expect(rejoined).toContain("Paragraph two also has some words");
  });
});

describe("splitOutboundMessageForOrchestrator", () => {
  it("behaves exactly like splitOutboundMessage when Chatty Mode is off", () => {
    const orchestrator = makeOrchestratorWithConfig({
      agents: { defaults: { split_on_marker: false } },
    });
    const text =
      "A moderately long single-paragraph reply that exceeds the limit set below for this test case.";
    const maxLength = 40;

    expect(
      splitOutboundMessageForOrchestrator(orchestrator, text, maxLength),
    ).toEqual(splitOutboundMessage(text, maxLength));
  });

  it("splits into multiple short human-like messages when Chatty Mode is on", () => {
    const orchestrator = makeOrchestratorWithConfig({
      agents: { defaults: { split_on_marker: true } },
    });
    const text =
      "Sure, I can help with that.\n\nLet's start with the first step, which is to check your configuration file.";

    const parts = splitOutboundMessageForOrchestrator(orchestrator, text, 4000);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toBe("Sure, I can help with that.");
  });

  it("still enforces the platform's hard length limit even in Chatty Mode", () => {
    const orchestrator = makeOrchestratorWithConfig({
      agents: { defaults: { split_on_marker: true } },
    });
    // A single long word-salad paragraph with no natural break points.
    const text = Array(50).fill("supercalifragilisticexpialidocious").join(" ");
    const maxLength = 50;

    const parts = splitOutboundMessageForOrchestrator(
      orchestrator,
      text,
      maxLength,
    );

    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(maxLength);
    }
    expect(parts.join(" ").replace(/\s+/g, " ")).toContain(
      "supercalifragilisticexpialidocious",
    );
  });
});
