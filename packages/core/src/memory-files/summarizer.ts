import type { SummarizerMode, SummaryDoc, TurnLike } from "./types.js";
import { redactSecrets } from "./redact.js";

/* ------------------------------------------------------------------ */
/* Heuristic (fully offline, deterministic) summarisation             */
/* ------------------------------------------------------------------ */

const DECISION_RE =
  /\b(remember|note that|don'?t forget|decided|decision|we will|we'll use|prefer(?:s|red)?|always|never|must|must not|from now on|deadline|due|my name is|i am a|i live|i work|use\b.+\binstead|switch(?:ed)? to)\b|মনে রাখ|মনে রেখ|ভুলো না|সিদ্ধান্ত|সবসময়|সর্বদা|কখনো|কখনও|আমার নাম|আমি থাকি|আমি কাজ করি|পছন্দ|থেকে শুরু|করতে হবে|করবে না|করবেন না|ব্যবহার করো|ব্যবহার করবে/i;

const FAIL_RE = /^\s*(error|failed|failure|exception|denied|timed out)\b|"success"\s*:\s*false|"ok"\s*:\s*false/i;

const CAPS = { topics: 8, decisions: 12, outcomes: 8, files: 10 } as const;

export function emptyDoc(): SummaryDoc {
  return { topics: [], decisions: [], outcomes: [], tools: {}, files: [], turns: 0 };
}

function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

function firstMeaningful(text: string, max: number): string {
  const first = sentences(text)[0] ?? text;
  return clip(first, max);
}

function pushUnique(list: string[], value: string): void {
  const key = value.toLowerCase();
  if (value && !list.some((v) => v.toLowerCase() === key)) list.push(value);
}

/** Keep the first `head` and the newest remainder when a list overflows. */
function capMixed(list: string[], cap: number, head: number): string[] {
  if (list.length <= cap) return list;
  const h = Math.min(head, cap);
  return [...list.slice(0, h), ...list.slice(list.length - (cap - h))];
}

function toolFile(name: string, rawArgs?: string): string | null {
  if (!/write|delete|create|edit|move|copy|mkdir/i.test(name) || !rawArgs) return null;
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    const v = args["path"] ?? args["file_path"] ?? args["file"] ?? args["filename"];
    return typeof v === "string" && v.trim() ? clip(v, 120) : null;
  } catch {
    return null;
  }
}

/** Distil raw turns into a structured, bounded doc. Never throws. */
export function extractDoc(turns: readonly TurnLike[]): SummaryDoc {
  const doc = emptyDoc();
  const idToName = new Map<string, string>();
  for (const turn of turns) {
    if (!turn || turn.is_error || turn.role === "system") continue;
    const content = String(turn.content ?? "");
    if (turn.role === "user") {
      doc.turns++;
      if (content.trim()) pushUnique(doc.topics, clip(content, 160));
      for (const s of sentences(content))
        if (DECISION_RE.test(s)) pushUnique(doc.decisions, clip(s, 220));
    } else if (turn.role === "assistant") {
      if (content.trim()) {
        doc.turns++;
        pushUnique(doc.outcomes, firstMeaningful(content, 200));
        for (const s of sentences(content))
          if (DECISION_RE.test(s)) pushUnique(doc.decisions, clip(s, 220));
      }
      for (const call of turn.tool_calls ?? []) {
        const name = call.function?.name || "tool";
        if (call.id) idToName.set(call.id, name);
        const entry = (doc.tools[name] ??= { n: 0, failed: 0 });
        entry.n++;
        const file = toolFile(name, call.function?.arguments);
        if (file) pushUnique(doc.files, file);
      }
    } else if (turn.role === "tool") {
      const name = turn.name || (turn.tool_call_id && idToName.get(turn.tool_call_id)) || "";
      if (name && FAIL_RE.test(content.slice(0, 200))) {
        (doc.tools[name] ??= { n: 0, failed: 0 }).failed++;
      }
    }
  }
  return normalizeDoc(doc);
}

function normalizeDoc(doc: SummaryDoc): SummaryDoc {
  return {
    ...doc,
    topics: capMixed(doc.topics, CAPS.topics, 3),
    decisions: capMixed(doc.decisions, CAPS.decisions, 4),
    outcomes: doc.outcomes.slice(-CAPS.outcomes),
    files: doc.files.slice(-CAPS.files),
  };
}

/** Fold `next` into `prev` (used when compaction runs more than once). */
export function mergeDocs(prev: SummaryDoc, next: SummaryDoc): SummaryDoc {
  const merged: SummaryDoc = {
    topics: [...prev.topics],
    decisions: [...prev.decisions],
    outcomes: [...prev.outcomes],
    files: [...prev.files],
    tools: {},
    turns: prev.turns + next.turns,
  };
  for (const t of next.topics) pushUnique(merged.topics, t);
  for (const d of next.decisions) pushUnique(merged.decisions, d);
  for (const o of next.outcomes) pushUnique(merged.outcomes, o);
  for (const f of next.files) pushUnique(merged.files, f);
  for (const src of [prev.tools, next.tools])
    for (const [name, v] of Object.entries(src)) {
      const e = (merged.tools[name] ??= { n: 0, failed: 0 });
      e.n += v.n;
      e.failed += v.failed;
    }
  return normalizeDoc(merged);
}

function toolsLine(tools: SummaryDoc["tools"]): string {
  return Object.entries(tools)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 10)
    .map(([name, v]) => `${name} ×${v.n}${v.failed ? ` (${v.failed} failed)` : ""}`)
    .join(", ");
}

/**
 * Render a doc as markdown, guaranteed <= maxChars. When over budget the
 * least valuable detail goes first (old outcomes, then middle topics);
 * standing decisions/facts are dropped last.
 */
export function renderDoc(doc: SummaryDoc, maxChars: number): string {
  const d = {
    topics: [...doc.topics],
    decisions: [...doc.decisions],
    outcomes: [...doc.outcomes],
    files: [...doc.files],
  };
  const build = (): string => {
    const parts: string[] = [];
    if (d.topics.length)
      parts.push(`**Topics / requests**\n${d.topics.map((t) => `- ${t}`).join("\n")}`);
    if (d.decisions.length)
      parts.push(`**Decisions & facts**\n${d.decisions.map((t) => `- ${t}`).join("\n")}`);
    if (d.outcomes.length)
      parts.push(`**Progress / outcomes**\n${d.outcomes.map((t) => `- ${t}`).join("\n")}`);
    const tl = toolsLine(doc.tools);
    if (tl) parts.push(`**Tools used**: ${tl}`);
    if (d.files.length) parts.push(`**Files touched**: ${d.files.join(", ")}`);
    return redactSecrets(parts.join("\n\n"));
  };
  let text = build();
  const order: Array<"outcomes" | "topics" | "files" | "decisions"> = [
    "outcomes",
    "topics",
    "files",
    "decisions",
  ];
  let guard = 200;
  while (text.length > maxChars && guard-- > 0) {
    const key = order.find((k) => d[k].length > (k === "decisions" ? 1 : 0));
    if (!key) break;
    // drop the oldest outcomes / a middle topic / oldest file / middle decision
    if (key === "outcomes" || key === "files") d[key].shift();
    else d[key].splice(Math.floor(d[key].length / 2), 1);
    text = build();
  }
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
}

export function deriveTitle(doc: SummaryDoc, fallback = "session"): string {
  const first = doc.topics[0];
  return first ? clip(first, 60) : fallback;
}

/**
 * Durable-looking facts only — what a pre-compaction flush writes down.
 *
 * Fix #6: Facts derived from assistant turns are marked [TENTATIVE] so they
 * are not stored as authoritative memory. A fact is only untagged when it
 * comes exclusively from a user turn (user confirmed/stated it). Assistant
 * text can contain speculative statements, incorrect summaries, or
 * hallucinations that should not persist as ground truth.
 */
export function extractDurableFacts(turns: readonly TurnLike[]): string[] {
  const doc = extractDoc(turns);

  // Build a set of text snippets that the USER explicitly stated.
  const userContent = turns
    .filter((t) => t.role === "user")
    .map((t) => String(t.content ?? "").toLowerCase())
    .join("\n");

  return doc.decisions.slice(0, 10).map((fact) => {
    // Check whether the first 40 chars of this fact appear in user turns.
    const probe = fact.slice(0, 40).toLowerCase();
    const userConfirmed = probe.length > 5 && userContent.includes(probe);
    return userConfirmed ? fact : `[TENTATIVE] ${fact}`;
  });
}

/* ------------------------------------------------------------------ */
/* Optional LLM summarisation (background only, always falls back)    */
/* ------------------------------------------------------------------ */

export type LlmComplete = (
  req: { system: string; user: string },
  opts: { signal: AbortSignal },
) => Promise<string>;

export interface SummarizerOptions {
  getMode: () => SummarizerMode;
  llm?: LlmComplete;
  /** In "auto" mode the LLM is used only when this returns true (e.g. remote model). */
  llmAllowed?: () => boolean;
  timeoutMs: number;
}

export interface SessionSummary {
  title: string;
  summary: string;
  via: "llm" | "heuristic";
}

export interface FlushNotes {
  notes: string[];
  via: "llm" | "heuristic";
}

export function buildTranscript(turns: readonly TurnLike[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (!t || t.is_error || t.role === "system") continue;
    let line: string;
    if (t.role === "tool") {
      line = `[tool ${t.name || ""}] ${clip(String(t.content ?? ""), 120)}`;
    } else if (t.role === "assistant" && !String(t.content ?? "").trim()) {
      const names = (t.tool_calls ?? []).map((c) => c.function?.name).filter(Boolean);
      line = `[assistant→tools] ${names.join(", ")}`;
    } else {
      line = `[${t.role}] ${clip(String(t.content ?? ""), 500)}`;
    }
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return redactSecrets(lines.join("\n"));
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`summariser timed out after ${ms}ms`));
        }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SESSION_SYSTEM =
  "You write compact memory notes for a long-running personal assistant so it can continue seamlessly in a later session. " +
  "Summarise; never quote the transcript. Keep the user's language. Never include passwords, tokens, keys or other secrets. " +
  "Output format: first line `TITLE: <max 8 words>`, then markdown under these bold headings (omit empty ones): " +
  "**Decisions & facts**, **What was done**, **Open items**. Bullets only, one idea per bullet.";

const FLUSH_SYSTEM = "Session nearing compaction. Store durable memories now.";

export class Summarizer {
  constructor(private readonly opts: SummarizerOptions) {}

  llmUsable(): boolean {
    const mode = this.opts.getMode();
    if (mode === "heuristic" || !this.opts.llm) return false;
    if (mode === "llm") return true;
    return this.opts.llmAllowed ? this.opts.llmAllowed() : true;
  }

  heuristicSession(turns: readonly TurnLike[], maxChars: number): SessionSummary {
    const doc = extractDoc(turns);
    return {
      title: deriveTitle(doc),
      summary: renderDoc(doc, maxChars),
      via: "heuristic",
    };
  }

  /** Session summary: LLM when allowed, heuristic on any failure. */
  async summarizeSession(
    turns: readonly TurnLike[],
    maxChars: number,
  ): Promise<SessionSummary> {
    const fallback = this.heuristicSession(turns, maxChars);
    if (!this.llmUsable() || !this.opts.llm) return fallback;
    try {
      const transcript = buildTranscript(turns, 12_000);
      if (!transcript.trim()) return fallback;
      const raw = await withTimeout(
        (signal) =>
          this.opts.llm!(
            {
              system: SESSION_SYSTEM,
              user: `Write the memory note for this conversation (max ~${maxChars} characters).\n\n${transcript}`,
            },
            { signal },
          ),
        this.opts.timeoutMs,
      );
      const text = redactSecrets(String(raw ?? "").trim());
      if (!text || /^NO_REPLY$/i.test(text)) return fallback;
      const m = text.match(/^\s*TITLE:\s*(.+)$/im);
      const body = text.replace(/^\s*TITLE:.*$/im, "").trim();
      if (!body) return fallback;
      return {
        title: clip(m?.[1] ?? fallback.title, 80),
        summary: body.length > maxChars * 2 ? `${body.slice(0, maxChars * 2)}…` : body,
        via: "llm",
      };
    } catch (err) {
      console.warn(
        `[memory] LLM summary failed, using heuristic: ${(err as Error).message}`,
      );
      return fallback;
    }
  }

  /**
   * Pre-compaction flush (OpenClaw's silent "write durable memory now"
   * turn). Runs on a detached copy of the turns; the reply is never shown
   * to the user. An exact NO_REPLY means "nothing worth storing".
   */
  async extractFlushNotes(turns: readonly TurnLike[]): Promise<FlushNotes> {
    const heuristic: FlushNotes = { notes: extractDurableFacts(turns), via: "heuristic" };
    if (!this.llmUsable() || !this.opts.llm) return heuristic;
    try {
      const transcript = buildTranscript(turns, 10_000);
      if (!transcript.trim()) return heuristic;
      const raw = await withTimeout(
        (signal) =>
          this.opts.llm!(
            {
              system: FLUSH_SYSTEM,
              user:
                "Write any lasting notes (decisions, preferences, facts, commitments) as bullet lines, each self-contained. " +
                "Reply with exactly NO_REPLY if nothing is worth storing.\n\n" +
                transcript,
            },
            { signal },
          ),
        this.opts.timeoutMs,
      );
      const text = String(raw ?? "").trim();
      if (!text || /^NO_REPLY$/i.test(text)) return { notes: [], via: "llm" };
      const bullets = text
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
        .filter((l) => l.length >= 6 && !/^NO_REPLY$/i.test(l))
        .slice(0, 10)
        .map((l) => clip(redactSecrets(l), 300));
      return { notes: bullets, via: "llm" };
    } catch (err) {
      console.warn(
        `[memory] LLM flush failed, using heuristic: ${(err as Error).message}`,
      );
      return heuristic;
    }
  }
}
