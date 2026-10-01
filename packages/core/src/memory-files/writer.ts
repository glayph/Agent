import type { MemoryFilesConfig, TurnLike, WriterStats } from "./types.js";
import { MemoryFileStore, executeOp, executeOpSync } from "./store.js";
import type { Summarizer } from "./summarizer.js";
import type { MemoryHooks } from "./hooks.js";
import { relFromRoot } from "./paths.js";

export type MemoryJob =
  /** Generic deferred work (e.g. the SQLite/TKG interaction log). */
  | { type: "task"; name: string; run: () => void | Promise<void> }
  | { type: "daily_note"; text: string; source?: string }
  | {
      type: "compaction_archive";
      sessionId: string;
      summary: string;
      archivedCount: number;
    }
  | { type: "session_summary"; sessionId: string; turns: TurnLike[]; reason: string }
  | { type: "flush"; sessionId: string; turns: TurnLike[] };

type Lane = "fast" | "slow";

const laneOf = (job: MemoryJob): Lane =>
  job.type === "session_summary" || job.type === "flush" ? "slow" : "fast";

/**
 * Background writer for everything memory does.
 *
 * Contract (step 02, behavior contract #1 and the correction protocol):
 *  - enqueue() returns immediately and NEVER throws — callers cannot be
 *    delayed by, or fail because of, memory I/O.
 *  - Disk/LLM failures are counted and logged once; they never propagate.
 *  - Two independent lanes: "fast" (plain file appends, deferred DB tasks)
 *    and "slow" (jobs that may call an LLM). A slow summary can therefore
 *    never hold up a fast write that the next turn depends on.
 *  - Each lane is strictly ordered (FIFO).
 */
export class MemoryWriter {
  private queues: Record<Lane, MemoryJob[]> = { fast: [], slow: [] };
  private running: Record<Lane, boolean> = { fast: false, slow: false };
  private closed = false;
  private processed = 0;
  private failed = 0;
  private dropped = 0;
  private lastError?: string;
  private readonly warned = new Set<string>();

  constructor(
    private readonly store: MemoryFileStore,
    private readonly summarizer: Summarizer,
    private readonly hooks: MemoryHooks,
    private readonly getConfig: () => MemoryFilesConfig,
  ) {}

  enqueue(job: MemoryJob): boolean {
    try {
      if (this.closed) return false;
      const lane = laneOf(job);
      const queue = this.queues[lane];
      if (lane === "slow" && queue.length >= this.getConfig().writer.maxSlowQueue) {
        this.dropped++;
        this.warnOnce("slow-queue-full", "[memory] summary queue full; dropping job");
        return false;
      }
      queue.push(job);
      this.schedule(lane);
      return true;
    } catch (err) {
      this.recordFailure("enqueue", err);
      return false;
    }
  }

  stats(): WriterStats {
    return {
      queuedFast: this.queues.fast.length,
      queuedSlow: this.queues.slow.length,
      processed: this.processed,
      failed: this.failed,
      dropped: this.dropped,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /** Wait until both lanes are idle (tests, graceful shutdown). */
  async drain(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (
        !this.running.fast &&
        !this.running.slow &&
        this.queues.fast.length === 0 &&
        this.queues.slow.length === 0
      )
        return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return false;
  }

  /**
   * Process-exit path: synchronously persist what is still queued (deferred
   * DB tasks, notes, archives, and heuristic — never LLM — summaries) so a
   * shutdown cannot lose data that the pre-async code would have written
   * inline. Afterwards the writer refuses new jobs.
   */
  drainSync(): void {
    this.closed = true;
    const pending = [...this.queues.fast, ...this.queues.slow];
    this.queues = { fast: [], slow: [] };
    for (const job of pending) {
      try {
        this.runJobSync(job);
        this.processed++;
      } catch (err) {
        this.recordFailure(job.type === "task" ? job.name : job.type, err);
      }
    }
  }

  // ---- internals -----------------------------------------------------

  private schedule(lane: Lane): void {
    if (this.running[lane]) return;
    this.running[lane] = true;
    setImmediate(() => void this.pump(lane));
  }

  private async pump(lane: Lane): Promise<void> {
    try {
      for (;;) {
        const job = this.queues[lane].shift();
        if (!job) break;
        try {
          await this.runJob(job);
          this.processed++;
        } catch (err) {
          this.recordFailure(job.type === "task" ? job.name : job.type, err);
        }
      }
    } finally {
      this.running[lane] = false;
      if (this.queues[lane].length > 0 && !this.closed) this.schedule(lane);
    }
  }

  private async runJob(job: MemoryJob): Promise<void> {
    switch (job.type) {
      case "task":
        await job.run();
        return;
      case "daily_note":
        await executeOp(this.store.planDailyNote(job.text, job.source));
        return;
      case "compaction_archive":
        await executeOp(this.store.planCompactionArchive(job));
        return;
      case "session_summary": {
        const s = await this.summarizer.summarizeSession(job.turns, 2_500);
        const file = await executeOp(
          this.store.planSessionSummary({
            sessionId: job.sessionId,
            title: s.title,
            summary: s.summary,
            reason: job.reason,
            via: s.via,
          }),
        );
        if (file)
          this.hooks.emit("session_saved", {
            sessionId: job.sessionId,
            path: relFromRoot(this.store.paths, file),
            reason: job.reason,
          });
        return;
      }
      case "flush": {
        const r = await this.summarizer.extractFlushNotes(job.turns);
        for (const note of r.notes)
          await executeOp(this.store.planDailyNote(note, "flush"));
        this.hooks.emit("flush", {
          sessionId: job.sessionId,
          noted: r.notes.length,
          via: r.notes.length === 0 && r.via === "llm" ? "none" : r.via,
        });
        return;
      }
    }
  }

  private runJobSync(job: MemoryJob): void {
    switch (job.type) {
      case "task": {
        const r = job.run();
        if (r && typeof (r as Promise<void>).catch === "function")
          (r as Promise<void>).catch((e) => this.recordFailure(job.name, e));
        return;
      }
      case "daily_note":
        executeOpSync(this.store.planDailyNote(job.text, job.source));
        return;
      case "compaction_archive":
        executeOpSync(this.store.planCompactionArchive(job));
        return;
      case "session_summary": {
        const s = this.summarizer.heuristicSession(job.turns, 2_500);
        executeOpSync(
          this.store.planSessionSummary({
            sessionId: job.sessionId,
            title: s.title,
            summary: s.summary,
            reason: job.reason,
            via: "heuristic",
          }),
        );
        return;
      }
      case "flush":
        // Durable facts are already picked up by the shutdown session summary.
        return;
    }
  }

  private recordFailure(name: string, err: unknown): void {
    this.failed++;
    const msg = err instanceof Error ? err.message : String(err);
    this.lastError = `${name}: ${msg}`;
    this.warnOnce(`${name}:${msg}`, `[memory] background ${name} failed (turn unaffected): ${msg}`);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    if (this.warned.size > 200) this.warned.clear();
    this.warned.add(key);
    console.warn(message);
  }
}
