import type { AgentOrchestrator } from "../agent.js";
import { sessionTurnLock } from "../session-turn-lock.js";

type AgentLoopOptions = Parameters<AgentOrchestrator["runAgentLoop"]>[3];

export function extractAgentChunkContent(chunk: string): string {
  try {
    const parsed = JSON.parse(chunk) as { type?: string; content?: unknown };
    if (
      parsed.type === "stream_chunk" ||
      parsed.type === "error" ||
      parsed.type === "final"
    ) {
      return typeof parsed.content === "string" ? parsed.content : "";
    }
  } catch {
    return chunk;
  }
  return "";
}

export async function streamAgentResponse(
  orchestrator: AgentOrchestrator,
  sessionId: string,
  message: string,
  onText: (text: string) => Promise<void> | void,
  maxChars = 12000,
  options?: AgentLoopOptions,
): Promise<string> {
  return sessionTurnLock.withLock(sessionId, async () => {
    let response = "";
    for await (const chunk of orchestrator.runAgentLoop(
      sessionId,
      message,
      undefined,
      options,
    )) {
      const content = extractAgentChunkContent(chunk);
      if (!content) continue;
      const remaining = maxChars - response.length;
      if (remaining <= 0) break;
      const next = content.slice(0, remaining);
      response += next;
      await onText(next);
      if (next.length < content.length) break;
    }
    return response.trim() || "No response was generated.";
  });
}

export async function collectAgentResponse(
  orchestrator: AgentOrchestrator,
  sessionId: string,
  message: string,
  maxChars = 12000,
  options?: AgentLoopOptions,
): Promise<string> {
  return sessionTurnLock.withLock(sessionId, async () => {
    let response = "";
    for await (const chunk of orchestrator.runAgentLoop(
      sessionId,
      message,
      undefined,
      options,
    )) {
      const content = extractAgentChunkContent(chunk);
      if (!content) continue;
      response += content;
      if (response.length >= maxChars) {
        response = `${response.slice(0, maxChars)}\n\n[Response truncated]`;
        break;
      }
    }
    return response.trim() || "No response was generated.";
  });
}

export function splitOutboundMessage(
  text: string,
  maxLength: number,
): string[] {
  if (text.length <= maxLength) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let slice = remaining.slice(0, maxLength);
    const breakAt = Math.max(
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(". "),
      slice.lastIndexOf(" "),
    );
    if (breakAt > Math.floor(maxLength * 0.5)) {
      slice = slice.slice(0, breakAt).trimEnd();
    }
    parts.push(slice);
    remaining = remaining.slice(slice.length).trimStart();
  }
  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * "Chatty Mode" (config: agents.defaults.split_on_marker). When enabled,
 * long replies are broken into several short, human-chat-sized messages
 * instead of one long block -- independent of any platform hard length
 * limit (that's still enforced separately by splitOutboundMessage).
 */
export function isChattyModeEnabled(orchestrator: AgentOrchestrator): boolean {
  const config = orchestrator.config;
  const agents = isRecord(config?.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  return defaults.split_on_marker === true;
}

const CHATTY_TARGET_LENGTH = 220;
const CHATTY_MIN_TAIL_LENGTH = 40;

/**
 * Splits text into short, natural chat-bubble-sized chunks: first on
 * paragraph breaks, then on sentence boundaries for any paragraph still
 * longer than the target length. Never splits mid-word/mid-sentence.
 */
export function splitForChattyMode(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.trim());
  const bubbles: string[] = [];

  for (const paragraph of paragraphs) {
    const clean = paragraph.trim();
    if (clean.length <= CHATTY_TARGET_LENGTH) {
      bubbles.push(clean);
      continue;
    }
    // Break the paragraph into sentences, then greedily pack sentences
    // into bubbles up to the target length so short sentences aren't
    // each sent as their own tiny message.
    const sentences = clean.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [
      clean,
    ];
    const paragraphBubbles: string[] = [];
    let current = "";
    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim();
      if (!sentence) continue;
      const candidate = current ? `${current} ${sentence}` : sentence;
      if (candidate.length <= CHATTY_TARGET_LENGTH || !current) {
        current = candidate;
      } else {
        paragraphBubbles.push(current);
        current = sentence;
      }
    }
    if (current) paragraphBubbles.push(current);

    // Avoid leaving a very short trailing fragment (e.g. a lone "Ok.")
    // as its own bubble by merging it back into the previous one. This
    // only applies within a single over-length paragraph's own sentence
    // packing, never across a real paragraph break the author wrote.
    for (let i = paragraphBubbles.length - 1; i > 0; i--) {
      if (paragraphBubbles[i].length < CHATTY_MIN_TAIL_LENGTH) {
        paragraphBubbles[i - 1] =
          `${paragraphBubbles[i - 1]} ${paragraphBubbles[i]}`;
        paragraphBubbles.splice(i, 1);
      }
    }

    bubbles.push(...paragraphBubbles);
  }

  return bubbles.length > 0 ? bubbles : [trimmed];
}

/**
 * Splits an outbound reply for a channel: applies Chatty Mode's
 * human-like short-message split first (when enabled for the agent),
 * then enforces the platform's hard length limit on every resulting
 * piece. When Chatty Mode is off, behaves exactly like
 * splitOutboundMessage() did before.
 */
export function splitOutboundMessageForOrchestrator(
  orchestrator: AgentOrchestrator,
  text: string,
  maxLength: number,
): string[] {
  const chunks = isChattyModeEnabled(orchestrator)
    ? splitForChattyMode(text)
    : [text];
  const parts: string[] = [];
  for (const chunk of chunks) {
    parts.push(...splitOutboundMessage(chunk, maxLength));
  }
  return parts;
}
