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

import type { AgentOrchestrator } from "../../../agent.js";
import {
  collectAgentResponse,
  streamAgentResponse,
  isChattyModeEnabled,
  splitForChattyMode,
  splitOutboundMessage,
  splitOutboundMessageForOrchestrator,
} from "./agent-response.js";
import { sessionTurnLock } from "../../../session-turn-lock.js";

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

/**
 * Regression tests for the Adaptive Multi-Message Output System's progress
 * messages: streamAgentResponse()/collectAgentResponse() now accept an
 * optional onProgress callback fed by real tool_call/tool_result/
 * action_update events from runAgentLoop() -- never fabricated, never fired
 * for events other than those three, and gated by messaging config so
 * fast/simple turns never grow an extra message.
 */
function makeEventOrchestrator(
  events: Array<Record<string, unknown>>,
  messagingConfig: Record<string, unknown> = {},
): AgentOrchestrator {
  return {
    config: { agents: { defaults: { messaging: messagingConfig } } },
    async *runAgentLoop() {
      for (const event of events) {
        yield JSON.stringify(event);
      }
    },
  } as unknown as AgentOrchestrator;
}

describe("collectAgentResponse onProgress", () => {
  it("does not call onProgress when it is omitted", async () => {
    const orchestrator = makeEventOrchestrator([
      { type: "tool_call", tool: "file_read", input: { path: "a.txt" } },
      { type: "final", content: "done" },
    ]);
    const reply = await collectAgentResponse(
      orchestrator,
      `s-${Date.now()}`,
      "hi",
    );
    expect(reply).toBe("done");
  });

  it("fires onProgress with the described tool action, once the min-delay gate is bypassed via config", async () => {
    const orchestrator = makeEventOrchestrator(
      [
        { type: "tool_call", tool: "file_read", input: { path: "a.txt" } },
        { type: "final", content: "done" },
      ],
      { min_ms_before_first_progress: 0 },
    );
    const progress: string[] = [];
    const reply = await collectAgentResponse(
      orchestrator,
      `s-${Date.now()}`,
      "hi",
      12000,
      undefined,
      (text) => {
        progress.push(text);
      },
    );
    expect(reply).toBe("done");
    expect(progress).toEqual(["Reading file: a.txt"]);
  });

  it("passes the model's own action_update text through unchanged", async () => {
    const orchestrator = makeEventOrchestrator(
      [
        { type: "action_update", content: "Checking the API config now." },
        { type: "final", content: "done" },
      ],
      { min_ms_before_first_progress: 0 },
    );
    const progress: string[] = [];
    await collectAgentResponse(
      orchestrator,
      `s-${Date.now()}`,
      "hi",
      12000,
      undefined,
      (text) => {
        progress.push(text);
      },
    );
    expect(progress).toEqual(["Checking the API config now."]);
  });

  it("never fires progress before minMsBeforeFirstProgress has elapsed", async () => {
    const orchestrator = makeEventOrchestrator(
      [
        { type: "tool_call", tool: "file_read", input: { path: "a.txt" } },
        { type: "final", content: "done" },
      ],
      { min_ms_before_first_progress: 60_000 },
    );
    const progress: string[] = [];
    await collectAgentResponse(
      orchestrator,
      `s-${Date.now()}`,
      "hi",
      12000,
      undefined,
      (text) => {
        progress.push(text);
      },
    );
    expect(progress).toEqual([]);
  });

  it("caps progress messages at maxMessagesPerResponse", async () => {
    const events: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      events.push({
        type: "tool_call",
        tool: "file_read",
        input: { path: `f${i}.txt` },
        invocation_index: i,
      });
    }
    events.push({ type: "final", content: "done" });
    const orchestrator = makeEventOrchestrator(events, {
      min_ms_before_first_progress: 0,
      min_ms_between_progress: 0,
      max_messages_per_response: 2,
    });
    const progress: string[] = [];
    await collectAgentResponse(
      orchestrator,
      `s-${Date.now()}`,
      "hi",
      12000,
      undefined,
      (text) => {
        progress.push(text);
      },
    );
    expect(progress.length).toBe(2);
  });

  it("does not emit progress when messaging.adaptive is false", async () => {
    const orchestrator = makeEventOrchestrator(
      [
        { type: "tool_call", tool: "file_read", input: { path: "a.txt" } },
        { type: "final", content: "done" },
      ],
      { adaptive: false, min_ms_before_first_progress: 0 },
    );
    const progress: string[] = [];
    await collectAgentResponse(
      orchestrator,
      `s-${Date.now()}`,
      "hi",
      12000,
      undefined,
      (text) => {
        progress.push(text);
      },
    );
    expect(progress).toEqual([]);
  });

  it("describes a failed tool_result using the real ok=false/output from the event", async () => {
    const orchestrator = makeEventOrchestrator(
      [
        {
          type: "tool_call",
          tool: "file_write",
          input: { path: "b.txt" },
          invocation_index: 0,
        },
        {
          type: "tool_result",
          tool: "file_write",
          invocation_index: 0,
          ok: false,
          output: "disk full",
          duration_ms: 12,
        },
        { type: "final", content: "done" },
      ],
      { min_ms_before_first_progress: 0, min_ms_between_progress: 0 },
    );
    const progress: string[] = [];
    await collectAgentResponse(
      orchestrator,
      `s-${Date.now()}`,
      "hi",
      12000,
      undefined,
      (text) => {
        progress.push(text);
      },
    );
    expect(progress[0]).toBe("Editing file: b.txt");
    expect(progress[1]).toContain("failed");
    expect(progress[1]).toContain("disk full");
  });
});

describe("streamAgentResponse onProgress", () => {
  it("fires onProgress independently of the onText streaming callback", async () => {
    const orchestrator = makeEventOrchestrator(
      [
        { type: "tool_call", tool: "file_read", input: { path: "a.txt" } },
        { type: "stream_chunk", content: "Hello " },
        { type: "stream_chunk", content: "world." },
      ],
      { min_ms_before_first_progress: 0 },
    );
    const progress: string[] = [];
    const streamed: string[] = [];
    const reply = await streamAgentResponse(
      orchestrator,
      `s-${Date.now()}`,
      "hi",
      (delta) => {
        streamed.push(delta);
      },
      undefined,
      undefined,
      (text) => {
        progress.push(text);
      },
    );
    expect(reply).toBe("Hello world.");
    expect(streamed.join("")).toBe("Hello world.");
    expect(progress).toEqual(["Reading file: a.txt"]);
  });

  it("does not call onProgress when it is omitted (existing channels unaffected)", async () => {
    const orchestrator = makeEventOrchestrator([
      { type: "tool_call", tool: "file_read", input: { path: "a.txt" } },
      { type: "stream_chunk", content: "hi" },
    ]);
    const streamed: string[] = [];
    const reply = await streamAgentResponse(
      orchestrator,
      `s-${Date.now()}`,
      "hi",
      (delta) => {
        streamed.push(delta);
      },
    );
    expect(reply).toBe("hi");
    expect(streamed).toEqual(["hi"]);
  });
});

describe("splitOutboundMessageForOrchestrator with messaging.adaptive", () => {
  it("chunks even when split_on_marker is unset, via messaging.adaptive+enableChunking defaults", () => {
    const orchestrator = makeOrchestratorWithConfig({});
    const text =
      "Sure, I can help with that.\n\nLet's start with the first step, which is to check your configuration file.";
    const parts = splitOutboundMessageForOrchestrator(orchestrator, text, 4000);
    expect(parts.length).toBeGreaterThan(1);
  });

  it("stops chunking when messaging.enableChunking is explicitly false and split_on_marker is off", () => {
    const orchestrator = makeOrchestratorWithConfig({
      agents: {
        defaults: {
          split_on_marker: false,
          messaging: { enable_chunking: false },
        },
      },
    });
    const text = "Sure, I can help with that.\n\nHere is a second paragraph.";
    const parts = splitOutboundMessageForOrchestrator(orchestrator, text, 4000);
    expect(parts).toEqual([text]);
  });

  it("clamps chunk size to messaging.maxChunkLength when it is smaller than the channel limit", () => {
    const orchestrator = makeOrchestratorWithConfig({
      agents: { defaults: { messaging: { max_chunk_length: 20 } } },
    });
    const text = Array(10).fill("supercalifragilistic").join(" ");
    const parts = splitOutboundMessageForOrchestrator(orchestrator, text, 4000);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("splitOutboundMessage preserves code blocks, tables, and URLs", () => {
  it("never splits a fenced code block that fits within the limit", () => {
    const code = "```ts\nfunction add(a: number, b: number) {\n  return a + b;\n}\n```";
    const text = `Here is the fix:\n\n${code}\n\nLet me know if that works.`;
    const parts = splitOutboundMessage(text, 100);
    // The whole fenced block must appear intact in exactly one part.
    const withCode = parts.filter((p) => p.includes("```"));
    expect(withCode).toHaveLength(1);
    expect(withCode[0]).toContain(code);
    expect(parts.join("")).toBe(text);
  });

  it("re-wraps an oversized code block into multiple still-valid fenced pieces", () => {
    const longBody = Array.from({ length: 30 }, (_, i) => `line ${i};`).join(
      "\n",
    );
    const code = `\`\`\`ts\n${longBody}\n\`\`\``;
    const parts = splitOutboundMessage(code, 60);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      // Every piece must be independently a complete, valid fenced block.
      expect(part.startsWith("```ts\n")).toBe(true);
      expect(part.trimEnd().endsWith("```")).toBe(true);
      expect(part.length).toBeLessThanOrEqual(60);
    }
    // No code line was dropped or duplicated across the split. The fenced
    // body is `${longBody}\n` (one trailing newline before the closing
    // fence), so that's what the rejoined pieces should equal.
    const rejoined = parts
      .map((p) => p.replace(/^```ts\n/, "").replace(/```\s*$/, ""))
      .join("");
    expect(rejoined).toBe(`${longBody}\n`);
  });

  it("never splits a markdown table apart when it fits within the limit", () => {
    const table =
      "| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n| c | 3 |";
    const text = `Results:\n\n${table}\n\nDone.`;
    const parts = splitOutboundMessage(text, 200);
    const withTable = parts.filter((p) => p.includes("| Name |"));
    expect(withTable).toHaveLength(1);
    expect(withTable[0]).toContain(table);
    expect(parts.join("")).toBe(text);
  });

  it("splits an oversized table only between rows, never mid-row", () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| row ${i} | value ${i} |`);
    const table = rows.join("\n");
    const parts = splitOutboundMessage(table, 60);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(60);
      // Every line in every piece is a complete row -- never a fragment.
      for (const line of part.split("\n").filter(Boolean)) {
        expect(rows).toContain(line);
      }
    }
    // No row was dropped or duplicated.
    const allLines = parts.join("\n").split("\n").filter(Boolean);
    expect(allLines).toEqual(rows);
  });

  it("never breaks a URL across two messages when it fits within the limit", () => {
    const url = "https://example.com/some/very/long/path/that/is/long";
    const text = `Check the docs here: ${url} for more details on this.`;
    const parts = splitOutboundMessage(text, 80);
    const withUrl = parts.filter((p) => p.includes(url));
    expect(withUrl).toHaveLength(1);
  });

  it("isolates a URL longer than the whole limit onto its own chunk(s) rather than merging it into prose", () => {
    const url = `https://example.com/${"x".repeat(80)}`;
    const text = `Check this out: ${url} thanks.`;
    const parts = splitOutboundMessage(text, 40);
    // "Check this out:" and "thanks." must never share a chunk with any
    // fragment of the (oversized) URL.
    for (const part of parts) {
      const hasUrlFragment = part.includes("example.com") || part.includes("xxxx");
      const hasProse =
        part.includes("Check this out") || part.includes("thanks");
      expect(hasUrlFragment && hasProse).toBe(false);
    }
    expect(parts.join("")).toBe(text);
  });

  it("keeps prose splitting (paragraph/sentence boundaries) unchanged when there is no code/table/URL", () => {
    const text =
      "First paragraph is short.\n\nSecond paragraph is also fairly short here.";
    const parts = splitOutboundMessage(text, 30);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(30);
    }
    // Every word survives, in order, once whitespace is normalized back.
    expect(parts.join(" ").replace(/\s+/g, " ").trim()).toBe(
      text.replace(/\s+/g, " ").trim(),
    );
  });
});
