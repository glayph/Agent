import { getLifecycleBus } from "../hooks/index.js";
import type { ChatMessage } from "@miki/config";
import type { MemoryFilesConfig, SummaryDoc, TurnLike } from "./types.js";
import { emptyDoc, extractDoc, mergeDocs, renderDoc } from "./summarizer.js";
import type { MemoryWriter } from "./writer.js";
import type { MemoryHooks } from "./hooks.js";
import type { MemoryFileStore } from "./store.js";
import { relFromRoot } from "./paths.js";

/** Marks the synthetic rolling-summary message so it is recognised (and folded) next time. */
export const SUMMARY_SENTINEL = "[CONTEXT SUMMARY — earlier turns compacted]";

export interface CompactionContext {
  /** Prompt budget in characters (same unit the runtime already uses). */
  budgetChars: number;
  /** Overrides for this call; default to config. */
  minMessages?: number;
  keepRecent?: number;
  triggerPercent?: number;
}

export interface CompactionResult {
  messages: ChatMessage[];
  compacted: boolean;
  archivedCount: number;
  summaryChars: number;
}

interface SessionState {
  doc: SummaryDoc;
  /** Prefix length already folded into doc; history is append-only in normal chat. */
  archivedMessages: number;
  compactions: number;
  /** One pre-compaction flush per cycle (reset after a compaction). */
  flushed: boolean;
}

const isSummary = (m: ChatMessage): boolean =>
  m.role === "system" && String(m.content ?? "").startsWith(SUMMARY_SENTINEL);

function sizeOf(m: ChatMessage): number {
  let n = String(m.content ?? "").length;
  if (m.tool_calls) {
    try {
      n += JSON.stringify(m.tool_calls).length;
    } catch {
      /* ignore */
    }
  }
  return n;
}

/**
 * Context compaction (OpenClaw parity, adapted).
 *
 * Non-destructive by construction:
 *  - it only rewrites the prompt view (a new array); the persisted session
 *    history is never touched;
 *  - older turns are folded into a rolling summary that keeps topics,
 *    decisions/facts, outcomes, tools and files — not a truncated tail;
 *  - the same summary is archived to memory/compactions/ so it stays
 *    searchable (memory_search / memory_get) after the prompt moves on;
 *  - the most recent turns stay verbatim, and a tool result is never
 *    separated from the assistant message that requested it.
 *
 * The in-loop summary is deterministic (no LLM call on the hot path), so
 * compaction adds no latency and works fully offline.
 */
export class CompactionManager {
  private state = new Map<string, SessionState>();

  constructor(
    private readonly getConfig: () => MemoryFilesConfig,
    private readonly writer: MemoryWriter,
    private readonly hooks: MemoryHooks,
    private readonly store: MemoryFileStore,
  ) {}

  private sessionState(sessionId: string): SessionState {
    let s = this.state.get(sessionId);
    if (!s) {
      s = { doc: emptyDoc(), archivedMessages: 0, compactions: 0, flushed: false };
      this.state.set(sessionId, s);
      if (this.state.size > 500) {
        const oldest = this.state.keys().next().value;
        if (oldest !== undefined && oldest !== sessionId) this.state.delete(oldest);
      }
    }
    return s;
  }

  forget(sessionId: string): void {
    this.state.delete(sessionId);
  }

  stats(): { sessions: number; totalCompactions: number } {
    let total = 0;
    for (const s of this.state.values()) total += s.compactions;
    return { sessions: this.state.size, totalCompactions: total };
  }

  /**
   * Compact `messages` when they exceed the configured share of the budget.
   * Never throws: on any internal problem the original messages are returned.
   */
  async compact(
    sessionId: string,
    messages: ChatMessage[],
    ctx: CompactionContext,
  ): Promise<CompactionResult> {
    const unchanged: CompactionResult = {
      messages,
      compacted: false,
      archivedCount: 0,
      summaryChars: 0,
    };
    try {
      const cfg = this.getConfig();
      if (!cfg.enabled || !cfg.compaction.enabled) return unchanged;
      const c = cfg.compaction;
      const chars = messages.reduce((sum, m) => sum + sizeOf(m), 0);
      const triggerPercent = ctx.triggerPercent ?? c.triggerPercent;
      const threshold = Math.floor((ctx.budgetChars * triggerPercent) / 100);
      const state = this.sessionState(sessionId);

      this.maybeFlush(sessionId, messages, chars, ctx.budgetChars, triggerPercent, state);

      const minMessages = ctx.minMessages ?? c.minMessages;
      if (messages.length < minMessages || chars <= threshold) return unchanged;

      const systemMessages = messages.filter((m) => m.role === "system" && !isSummary(m));
      const conversational = messages.filter((m) => m.role !== "system");
      const keepRecent = Math.max(2, ctx.keepRecent ?? c.keepRecent);
      const keepRecentChars = Math.max(
        1_000,
        Math.min(c.keepRecentTokens * 4, Math.floor(ctx.budgetChars * 0.5)),
      );
      let tokenStart = conversational.length;
      let tailChars = 0;
      while (tokenStart > 0 && tailChars < keepRecentChars) {
        tokenStart--;
        tailChars += sizeOf(conversational[tokenStart]!);
      }
      let start = Math.min(conversational.length - keepRecent, tokenStart);
      // A tool result must stay with the assistant message that requested it.
      while (start > 0 && conversational[start]?.role === "tool") start--;
      if (start <= 0) return unchanged;

      const older = conversational.slice(0, start);
      const recent = conversational.slice(start);
      getLifecycleBus().emit("session:compact:before", { phase: "before" });
      this.hooks.emit("before_compaction", {
        sessionId,
        messageCount: messages.length,
        chars,
        thresholdChars: threshold,
      });

      // Fold only the newly archived prefix. This avoids re-tokenizing the full
      // transcript and appending the same summary material on every later turn.
      if (older.length < state.archivedMessages) {
        state.doc = emptyDoc();
        state.archivedMessages = 0;
      }
      const freshTurns = older.slice(state.archivedMessages);
      const fresh = extractDoc(freshTurns as TurnLike[]);
      const doc = mergeDocs(state.doc, fresh);
      const archivePath = this.store.compactionArchivePath(sessionId);
      const rel = relFromRoot(this.store.paths, archivePath);
      const rendered = renderDoc(doc, c.maxSummaryChars);
      if (!rendered.trim()) return unchanged;
      const summaryMessage: ChatMessage = {
        role: "system",
        content:
          `${SUMMARY_SENTINEL}\n` +
          `${doc.turns} earlier messages were compacted to fit the context window. ` +
          `Nothing was deleted: the full session history is intact and this summary is archived at ${rel} ` +
          `(use memory_search / memory_get to recover details).\n\n${rendered}`,
      };

      state.doc = doc;
      state.archivedMessages = older.length;
      state.compactions++;
      state.flushed = false;

      const archiveDelta = renderDoc(fresh, c.maxSummaryChars);
      if (archiveDelta.trim()) {
        this.writer.enqueue({
          type: "compaction_archive",
          sessionId,
          summary: archiveDelta,
          archivedCount: freshTurns.length,
        });
      }
      getLifecycleBus().emit("session:compact:after", { phase: "after" });
      this.hooks.emit("after_compaction", {
        sessionId,
        archivedCount: older.length,
        keptCount: recent.length,
        summaryChars: rendered.length,
        archivePath: rel,
      });

      return {
        messages: [...systemMessages, summaryMessage, ...recent],
        compacted: true,
        archivedCount: older.length,
        summaryChars: rendered.length,
      };
    } catch (err) {
      console.warn(
        `[memory] compaction skipped (${(err as Error).message}); using original context`,
      );
      return unchanged;
    }
  }

  /**
   * OpenClaw's pre-compaction memory flush: shortly before the compaction
   * threshold, durable facts are written to the daily note in the
   * background from a detached copy of the recent turns — the user never
   * sees it and it never enters the transcript. Once per compaction cycle.
   */
  private maybeFlush(
    sessionId: string,
    messages: ChatMessage[],
    chars: number,
    budgetChars: number,
    triggerPercent: number,
    state: SessionState,
  ): void {
    const { compaction: c } = this.getConfig();
    if (!c.flushEnabled || state.flushed) return;
    const softPercent = Math.max(1, triggerPercent - c.flushMarginPercent);
    if (chars <= Math.floor((budgetChars * softPercent) / 100)) return;
    state.flushed = true;
    const turns = messages
      .filter((m) => m.role !== "system")
      .slice(-40)
      .map((m) => ({ ...m })) as TurnLike[];
    this.writer.enqueue({ type: "flush", sessionId, turns });
  }
}
