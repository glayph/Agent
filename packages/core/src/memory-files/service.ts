import type { ChatMessage } from "@miki/config";
import type { MemoryFilesConfig, MemoryPaths, TurnLike } from "./types.js";
import { resolveMemoryFilesConfig } from "./config.js";
import { resolveMemoryPaths, relFromRoot } from "./paths.js";
import { MemoryFileStore, executeOp } from "./store.js";
import { MemoryHooks } from "./hooks.js";
import { Summarizer, type LlmComplete } from "./summarizer.js";
import { MemoryWriter } from "./writer.js";
import { CompactionManager } from "./compaction.js";
import { MemoryContextBuilder } from "./context.js";
import { MemorySearchIndex, readMemoryRange, type GetResult, type SearchHit } from "./search.js";

export interface FileMemoryServiceOptions {
  identityDir: string;
  /** The raw `agent.memory` config block (files sub-block is read from it). */
  agentMemoryConfig?: unknown;
  seed?: Partial<{ summarizeTokenPercent: number; summarizeMessageThreshold: number }>;
  /** Background LLM used for summaries/flush. Optional — heuristics work without it. */
  llm?: LlmComplete;
  /** In "auto" mode the LLM is used only while this returns true (e.g. not a local model). */
  llmAllowed?: () => boolean;
}

export interface SessionSource {
  list(): Array<{
    sessionId: string;
    updatedAtMs: number;
    messages: () => ChatMessage[];
  }>;
}

const MAX_NOTE_CHARS = 2_000;

function toTurn(m: ChatMessage): TurnLike {
  return {
    role: m.role,
    content: m.content,
    ...(m.name ? { name: m.name } : {}),
    ...(m.is_error ? { is_error: true } : {}),
    ...(m.created_at ? { created_at: m.created_at } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls
      ? {
          tool_calls: m.tool_calls.map((c) => ({
            ...(c.id ? { id: c.id } : {}),
            function: { name: c.function?.name, arguments: c.function?.arguments },
          })),
        }
      : {}),
  };
}

/**
 * Facade for the whole file-memory subsystem. One instance per agent;
 * systemwide (not scoped to any workspace folder or project).
 */
export class FileMemoryService {
  readonly hooks = new MemoryHooks();
  readonly store: MemoryFileStore;
  readonly summarizer: Summarizer;
  readonly writer: MemoryWriter;
  readonly compaction: CompactionManager;
  private readonly contextBuilder: MemoryContextBuilder;
  private readonly searchIndex: MemorySearchIndex;
  private cfg: MemoryFilesConfig;
  private readonly paths: MemoryPaths;
  private readonly summarized = new Map<string, string>();
  private readonly swept = new Map<string, number>();
  private sweeper?: NodeJS.Timeout;
  private sweepSource?: SessionSource;

  constructor(private readonly opts: FileMemoryServiceOptions) {
    this.cfg = resolveMemoryFilesConfig(opts.agentMemoryConfig, opts.seed);
    this.paths = resolveMemoryPaths(opts.identityDir, this.cfg.dir);
    this.store = new MemoryFileStore(this.paths);
    this.summarizer = new Summarizer({
      getMode: () => this.cfg.summarizer,
      ...(opts.llm ? { llm: opts.llm } : {}),
      ...(opts.llmAllowed ? { llmAllowed: opts.llmAllowed } : {}),
      timeoutMs: this.cfg.summaryTimeoutMs,
    });
    this.writer = new MemoryWriter(this.store, this.summarizer, this.hooks, () => this.cfg);
    this.compaction = new CompactionManager(() => this.cfg, this.writer, this.hooks, this.store);
    this.contextBuilder = new MemoryContextBuilder(this.store, () => this.cfg);
    this.searchIndex = new MemorySearchIndex(this.store);
  }

  isEnabled(): boolean {
    return this.cfg.enabled;
  }
  config(): MemoryFilesConfig {
    return this.cfg;
  }
  memoryPaths(): MemoryPaths {
    return this.paths;
  }

  /** Re-read `agent.memory.files` after a config reload (paths stay fixed until restart). */
  updateConfig(agentMemoryConfig?: unknown, seed?: FileMemoryServiceOptions["seed"]): void {
    this.cfg = resolveMemoryFilesConfig(agentMemoryConfig, seed ?? this.opts.seed);
  }

  // ---- prompt context ----------------------------------------------------

  /** Memory block for the system prompt. Never throws; "" when there is nothing. */
  async buildContextBlock(opts: { compact?: boolean } = {}): Promise<string> {
    try {
      return await this.contextBuilder.build(opts);
    } catch (err) {
      console.warn(`[memory] context block skipped: ${(err as Error).message}`);
      return "";
    }
  }

  // ---- tools -------------------------------------------------------------

  search(query: string, limit = 5): Promise<SearchHit[]> {
    return this.searchIndex.search(query, limit);
  }

  get(relPath: string, from?: number, lines?: number): Promise<GetResult> {
    return readMemoryRange(this.paths, relPath, from, lines);
  }

  /** Explicit "remember this" — awaited because it is the tool's own result. */
  async note(
    text: string,
    scope: "long_term" | "daily",
  ): Promise<{ path: string; duplicate: boolean }> {
    const clean = text.trim().slice(0, MAX_NOTE_CHARS);
    if (!clean) throw new Error("text is empty");
    const op =
      scope === "daily"
        ? this.store.planDailyNote(clean, "agent")
        : this.store.planLongTermNote(clean);
    const written = await executeOp(op);
    return { path: relFromRoot(this.paths, op.path), duplicate: written === null };
  }

  // ---- background work ---------------------------------------------------

  /**
   * Run `fn` off the caller's critical path (used for the SQLite/TKG
   * interaction log). Falls back to running inline only when the writer is
   * already closed (shutdown), so nothing is lost. Never throws.
   */
  background(name: string, fn: () => void | Promise<void>): void {
    if (this.writer.enqueue({ type: "task", name, run: fn })) return;
    try {
      const r = fn();
      if (r && typeof (r as Promise<void>).catch === "function")
        (r as Promise<void>).catch((e) => console.warn(`[memory] ${name} failed:`, e));
    } catch (err) {
      console.warn(`[memory] ${name} failed:`, err);
    }
  }

  noteDaily(text: string, source = "agent"): void {
    if (!this.cfg.enabled) return;
    this.writer.enqueue({ type: "daily_note", text, source });
  }

  // ---- session lifecycle -------------------------------------------------

  /**
   * Save a session summary in the background (OpenClaw's session-memory
   * hook: runs when a session ends). Returns immediately. Idempotent per
   * unchanged conversation.
   */
  onSessionEnd(sessionId: string, messages: readonly ChatMessage[], reason: string): boolean {
    try {
      if (!this.cfg.enabled) return false;
      const dialog = messages.filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          !m.is_error &&
          String(m.content ?? "").trim(),
      );
      if (dialog.length < this.cfg.minTurnsForSummary) return false;
      if (!dialog.some((m) => m.role === "user")) return false;
      const last = dialog[dialog.length - 1]!;
      const sig = `${dialog.length}:${last.id ?? ""}:${last.created_at ?? ""}:${String(last.content).length}`;
      if (this.summarized.get(sessionId) === sig) return false;
      const firstKept = dialog[Math.max(0, dialog.length - this.cfg.summaryTurns)]!;
      const startIdx = Math.max(0, messages.indexOf(firstKept));
      const turns = messages.slice(startIdx).map(toTurn);
      const queued = this.writer.enqueue({ type: "session_summary", sessionId, turns, reason });
      if (queued) {
        this.summarized.set(sessionId, sig);
        if (this.summarized.size > 1_000) {
          const oldest = this.summarized.keys().next().value;
          if (oldest !== undefined) this.summarized.delete(oldest);
        }
      }
      return queued;
    } catch (err) {
      console.warn(`[memory] session summary skipped: ${(err as Error).message}`);
      return false;
    }
  }

  /** Session is gone for good (deleted): summarise it, then drop per-session state. */
  onSessionClosed(sessionId: string, messages: readonly ChatMessage[], reason: string): void {
    this.onSessionEnd(sessionId, messages, reason);
    this.compaction.forget(sessionId);
    this.swept.delete(sessionId);
  }

  startSessionSweeper(source: SessionSource, everyMs?: number): void {
    this.stopSessionSweeper();
    this.sweepSource = source;
    const idleMs = this.cfg.sessionIdleMinutes * 60_000;
    if (!this.cfg.enabled || idleMs <= 0) return;
    const period = everyMs ?? Math.max(15_000, Math.min(60_000, Math.floor(idleMs / 2)));
    this.sweeper = setInterval(() => this.sweepNow(), period);
    this.sweeper.unref?.();
  }

  stopSessionSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  /** Summarise every session that has been idle long enough. Cheap when nothing changed. */
  sweepNow(now = Date.now()): number {
    const source = this.sweepSource;
    const idleMs = this.cfg.sessionIdleMinutes * 60_000;
    if (!source || !this.cfg.enabled || idleMs <= 0) return 0;
    let queued = 0;
    try {
      for (const s of source.list()) {
        if (now - s.updatedAtMs < idleMs) continue;
        if (this.swept.get(s.sessionId) === s.updatedAtMs) continue;
        this.swept.set(s.sessionId, s.updatedAtMs);
        if (this.onSessionEnd(s.sessionId, s.messages(), "idle")) queued++;
      }
    } catch (err) {
      console.warn(`[memory] idle sweep skipped: ${(err as Error).message}`);
    }
    return queued;
  }

  /**
   * Process exit: stop timers, queue summaries for sessions not yet saved,
   * and synchronously persist everything pending (heuristic summaries only).
   */
  shutdown(): void {
    try {
      this.stopSessionSweeper();
      const source = this.sweepSource;
      if (source && this.cfg.enabled) {
        for (const s of source.list()) this.onSessionEnd(s.sessionId, s.messages(), "shutdown");
      }
    } catch (err) {
      console.warn(`[memory] shutdown summaries skipped: ${(err as Error).message}`);
    } finally {
      this.writer.drainSync();
    }
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.cfg.enabled,
      root: this.paths.root,
      memoryMd: this.paths.memoryMd,
      summarizer: this.cfg.summarizer,
      llmSummaries: this.summarizer.llmUsable(),
      writer: this.writer.stats(),
      compaction: this.compaction.stats(),
    };
  }
}
