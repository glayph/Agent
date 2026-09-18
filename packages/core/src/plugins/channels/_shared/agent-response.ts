import type { AgentOrchestrator } from "../../../agent.js";
import { sessionTurnLock } from "../../../session-turn-lock.js";
import {
  toolActionDescription,
  toolResultDescription,
} from "../../../api/inspector-events.js";
import { getMessagingConfig, type MessagingConfig } from "../../../messaging/config.js";

type AgentLoopOptions = Parameters<AgentOrchestrator["runAgentLoop"]>[3];

export type ProgressCallback = (text: string) => Promise<void> | void;

/** Per-call anti-spam state for progress messages (spec section 8). A fresh
 * gate is created once per streamAgentResponse()/collectAgentResponse()
 * call and threaded through every chunk of that one turn. */
interface ProgressGate {
  count: number;
  lastAt: number;
  startedAt: number;
}

function newProgressGate(): ProgressGate {
  return { count: 0, lastAt: 0, startedAt: Date.now() };
}

function progressAllowed(gate: ProgressGate, cfg: MessagingConfig): boolean {
  if (!cfg.adaptive || !cfg.enableProgressMessages) return false;
  const now = Date.now();
  if (now - gate.startedAt < cfg.minMsBeforeFirstProgress) return false;
  if (gate.count >= cfg.maxMessagesPerResponse) return false;
  if (now - gate.lastAt < cfg.minMsBetweenProgress) return false;
  return true;
}

/**
 * Turns one raw runAgentLoop() chunk into a short progress line, or null if
 * this chunk isn't a progress-worthy event (spec sections 4/6). Reuses the
 * exact same pure describers (toolActionDescription/toolResultDescription
 * from api/inspector-events.ts) that already drive the Web UI's Live
 * Activity Strip and inspector "thought" messages -- so a Telegram/Discord/
 * etc. progress line says the same thing the Web UI already says for the
 * same real event, from one source of truth, not a second guess at it.
 *
 * Never invents status text: `action_update` passes through only the
 * model's own sentence (same rule api/index.ts#_sendAiActionUpdate already
 * follows); `tool_call`/`tool_result` text is generated from the real
 * tool name/input/output/duration on that event, nothing assumed.
 */
function extractProgressText(
  chunk: string,
  toolInputs: Map<number, unknown>,
): string | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(chunk) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event.type === "action_update") {
    return typeof event.content === "string" ? event.content : null;
  }
  if (event.type === "tool_call") {
    const idx = Number(event.invocation_index ?? 0);
    toolInputs.set(idx, event.input);
    return toolActionDescription(event.tool, event.input);
  }
  if (event.type === "tool_result") {
    const idx = Number(event.invocation_index ?? 0);
    return toolResultDescription(
      event.tool,
      toolInputs.get(idx),
      event.ok === true,
      event.output,
      event.duration_ms,
      160,
    );
  }
  return null;
}

async function maybeEmitProgress(
  chunk: string,
  toolInputs: Map<number, unknown>,
  gate: ProgressGate,
  cfg: MessagingConfig,
  onProgress: ProgressCallback | undefined,
): Promise<void> {
  if (!onProgress) return;
  const text = extractProgressText(chunk, toolInputs);
  if (!text) return;
  const trimmed = text.trim();
  if (!trimmed || !progressAllowed(gate, cfg)) return;
  gate.count += 1;
  gate.lastAt = Date.now();
  await onProgress(trimmed);
}

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
  onProgress?: ProgressCallback,
): Promise<string> {
  return sessionTurnLock.withLock(sessionId, async () => {
    let response = "";
    const cfg = getMessagingConfig(orchestrator);
    const gate = newProgressGate();
    const toolInputs = new Map<number, unknown>();
    for await (const chunk of orchestrator.runAgentLoop(
      sessionId,
      message,
      undefined,
      options,
    )) {
      await maybeEmitProgress(chunk, toolInputs, gate, cfg, onProgress);
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
  onProgress?: ProgressCallback,
): Promise<string> {
  return sessionTurnLock.withLock(sessionId, async () => {
    let response = "";
    const cfg = getMessagingConfig(orchestrator);
    const gate = newProgressGate();
    const toolInputs = new Map<number, unknown>();
    for await (const chunk of orchestrator.runAgentLoop(
      sessionId,
      message,
      undefined,
      options,
    )) {
      await maybeEmitProgress(chunk, toolInputs, gate, cfg, onProgress);
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

type TextSegment = { type: "text" | "code" | "table" | "url"; content: string };

const CODE_FENCE_RE = /```[^\n]*\n[\s\S]*?```/g;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;

/** Splits `text` on every match of `regex` (which must be a global regex),
 * tagging each match as `type` and everything between matches as "text".
 * Concatenating the result reproduces `text` exactly. */
function extractByRegex(
  text: string,
  regex: RegExp,
  type: TextSegment["type"],
): TextSegment[] {
  const segments: TextSegment[] = [];
  let pos = 0;
  const re = new RegExp(regex);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > pos) segments.push({ type: "text", content: text.slice(pos, m.index) });
    segments.push({ type, content: m[0] });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) segments.push({ type: "text", content: text.slice(pos) });
  return segments;
}

/** Groups consecutive markdown-table-row lines ("| ... |") into their own
 * atomic segments (2+ consecutive rows only, so a lone "|" in prose isn't
 * misclassified), leaving everything else as plain text. Splitting on a
 * lookbehind for "\n" keeps each line's own trailing newline attached, so
 * segments always reconstruct the input exactly when concatenated. */
function segmentTablesAndText(text: string): TextSegment[] {
  if (!text) return [];
  const lines = text.split(/(?<=\n)/);
  const isTableRow = (line: string) => /^\s*\|.*\|/.test(line);
  const segments: TextSegment[] = [];
  let textBuf = "";
  let i = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i])) {
      let j = i;
      while (j < lines.length && isTableRow(lines[j])) j++;
      if (j - i >= 2) {
        if (textBuf) {
          segments.push({ type: "text", content: textBuf });
          textBuf = "";
        }
        segments.push({ type: "table", content: lines.slice(i, j).join("") });
        i = j;
        continue;
      }
    }
    textBuf += lines[i];
    i++;
  }
  if (textBuf) segments.push({ type: "text", content: textBuf });
  return segments;
}

/** Partitions text into an ordered, lossless sequence of segments -- fenced
 * code blocks, markdown tables, and URLs are kept as atomic "code"/"table"/
 * "url" segments (spec section 2: "never split code blocks ... URLs ...
 * or tables"), everything else is "text". Concatenating every segment's
 * content reproduces the original string exactly. Runs as a pipeline: each
 * stage only looks inside the previous stage's leftover "text" segments, so
 * e.g. a URL that happens to appear inside a code block is left alone (the
 * code block already won at stage 1). */
function segmentPreservingBlocks(text: string): TextSegment[] {
  let segments = extractByRegex(text, CODE_FENCE_RE, "code");
  segments = segments.flatMap((seg) =>
    seg.type === "text" ? segmentTablesAndText(seg.content) : [seg],
  );
  segments = segments.flatMap((seg) =>
    seg.type === "text" ? extractByRegex(seg.content, URL_RE, "url") : [seg],
  );
  return segments;
}

/** The original length-based splitter (paragraph/sentence/word boundaries),
 * applied to a single plain-text segment that contains no code fences,
 * tables, or URLs (those are already extracted as atomic blocks upstream,
 * so this never needs to reason about them). */
function splitPlainText(text: string, maxLength: number): string[] {
  if (!text) return [];
  if (text.length <= maxLength) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }
    const slice = remaining.slice(0, maxLength);
    const breakAt = Math.max(
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(". "),
      slice.lastIndexOf(" "),
    );
    const piece =
      breakAt > Math.floor(maxLength * 0.5)
        ? slice.slice(0, breakAt).trimEnd()
        : slice;
    parts.push(piece);
    remaining = remaining.slice(piece.length).trimStart();
  }
  return parts;
}

/** Splits a single fenced code block that's longer than maxLength on its
 * own, re-wrapping each piece with the same opening fence/language tag so
 * every piece stays a valid, independently-renderable code block. Only
 * breaks between lines, never mid-line unless one line alone exceeds the
 * budget. */
function splitOversizedCodeBlock(block: string, maxLength: number): string[] {
  const match = /^```([^\n]*)\n([\s\S]*?)```\s*$/.exec(block);
  if (!match) return splitPlainText(block, maxLength); // malformed/unterminated fence: best effort
  const [, lang, body] = match;
  const fenceOpen = `\`\`\`${lang}\n`;
  const fenceClose = "```";
  const budget = Math.max(maxLength - fenceOpen.length - fenceClose.length, 40);
  const lines = body.split(/(?<=\n)/);
  const chunks: string[] = [];
  let current = "";
  for (let line of lines) {
    while (line.length > budget) {
      if (current) {
        chunks.push(fenceOpen + current + fenceClose);
        current = "";
      }
      chunks.push(fenceOpen + line.slice(0, budget) + fenceClose);
      line = line.slice(budget);
    }
    if ((current + line).length > budget) {
      chunks.push(fenceOpen + current + fenceClose);
      current = line;
    } else {
      current += line;
    }
  }
  if (current) chunks.push(fenceOpen + current + fenceClose);
  return chunks;
}

/** Splits a table that's longer than maxLength on its own, only ever
 * breaking between rows (never mid-row) unless a single row alone exceeds
 * maxLength, which gets a last-resort hard cut. */
function splitOversizedTable(content: string, maxLength: number): string[] {
  const lines = content.split(/(?<=\n)/);
  const chunks: string[] = [];
  let current = "";
  for (let line of lines) {
    while (line.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(line.slice(0, maxLength));
      line = line.slice(maxLength);
    }
    if ((current + line).length > maxLength) {
      chunks.push(current);
      current = line;
    } else {
      current += line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function splitOutboundMessage(
  text: string,
  maxLength: number,
): string[] {
  if (text.length <= maxLength) return [text];

  const segments = segmentPreservingBlocks(text);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };
  const appendAtomic = (piece: string) => {
    if (!current) {
      current = piece;
      return;
    }
    if ((current + piece).length <= maxLength) {
      current += piece;
    } else {
      flush();
      current = piece;
    }
  };

  for (const seg of segments) {
    if (seg.type === "text") {
      for (const piece of splitPlainText(seg.content, maxLength)) {
        appendAtomic(piece);
      }
      continue;
    }
    if (seg.content.length <= maxLength) {
      appendAtomic(seg.content);
      continue;
    }
    // The block itself doesn't fit in one message even alone -- never merge
    // it with neighboring content, split it internally instead.
    flush();
    if (seg.type === "code") {
      chunks.push(...splitOversizedCodeBlock(seg.content, maxLength));
    } else if (seg.type === "table") {
      chunks.push(...splitOversizedTable(seg.content, maxLength));
    } else {
      // A URL longer than the whole message limit: no valid break point
      // exists (spec's "never split a URL" can't be honored when it alone
      // exceeds the platform's hard cap), so it gets a last-resort hard cut,
      // but at least isolated on its own chunk(s) rather than torn apart
      // while mixed with surrounding prose.
      let rest = seg.content;
      while (rest.length > 0) {
        chunks.push(rest.slice(0, maxLength));
        rest = rest.slice(maxLength);
      }
    }
  }
  flush();
  return chunks;
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
 * human-like short-message split first (when enabled for the agent --
 * either via the older `split_on_marker` flag, or via the new
 * `messaging.adaptive` + `messaging.enableChunking`, see messaging/config.ts),
 * then enforces the platform's hard length limit on every resulting piece
 * (clamped further by `messaging.maxChunkLength` if that's set and smaller).
 * When neither is enabled, behaves exactly like splitOutboundMessage() did
 * before this system existed.
 */
export function splitOutboundMessageForOrchestrator(
  orchestrator: AgentOrchestrator,
  text: string,
  maxLength: number,
): string[] {
  const cfg = getMessagingConfig(orchestrator);
  const chunkingEnabled =
    isChattyModeEnabled(orchestrator) || (cfg.adaptive && cfg.enableChunking);
  const effectiveMax =
    cfg.maxChunkLength > 0 ? Math.min(maxLength, cfg.maxChunkLength) : maxLength;
  const chunks = chunkingEnabled ? splitForChattyMode(text) : [text];
  const parts: string[] = [];
  for (const chunk of chunks) {
    parts.push(...splitOutboundMessage(chunk, effectiveMax));
  }
  return parts;
}
