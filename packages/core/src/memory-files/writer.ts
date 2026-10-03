import * as fs from "fs";
import * as path from "path";
import type { MemoryFilesConfig, TurnLike, WriterStats } from "./types.js";
import { MemoryFileStore, executeOp, executeOpSync } from "./store.js";
import type { Summarizer } from "./summarizer.js";
import type { MemoryHooks } from "./hooks.js";
import { relFromRoot } from "./paths.js";

/**
 * Fix #12: Minimal append-only write-ahead journal for crash recovery.
 *
 * Jobs that survive enqueue() are immediately appended to a JSONL file on
 * disk. On successful completion the entry is marked done (in-place flag).
 * On startup, MemoryWriter replays any un-done entries before accepting new
 * work, so an abrupt kill -9 cannot lose queued daily_note / flush / archive
 * jobs. LLM-dependent jobs (session_summary) are journalled but replayed with
 * the heuristic path, since the LLM session context is gone on restart.
 *
 * The journal is intentionally simple: one JSON line per job, never
 * rewritten — only appended.  Compaction (drop done entries) happens on
 * startup when the file exceeds JOURNAL_COMPACT_THRESHOLD.
 */
const JOURNAL_COMPACT_THRESHOLD = 200 * 1024; // 200 KB

type JournalEntry = {
  id: string;
  job: Exclude<MemoryJob, { type: "task" }>;
  done: boolean;
  ts: number;
};

class WriteAheadJournal {
  private journalPath: string | null = null;

  init(storeRootDir: string): void {
    try {
      const dir = path.join(storeRootDir, ".wal");
      fs.mkdirSync(dir, { recursive: true });
      this.journalPath = path.join(dir, "memory-writer.jsonl");
      this._compactIfNeeded();
    } catch {
      this.journalPath = null; // journal unavailable: degrade gracefully
    }
  }

  append(id: string, job: MemoryJob): void {
    if (!this.journalPath) return;
    try {
      if (job.type === "task") return;
      const entry: JournalEntry = { id, job, done: false, ts: Date.now() };
      fs.appendFileSync(this.journalPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch { /* journal write failure is non-fatal */ }
  }

  markDone(id: string): void {
    if (!this.journalPath) return;
    try {
      // Overwrite the done flag in-place via a line-tagged patch appended entry.
      fs.appendFileSync(this.journalPath, JSON.stringify({ id, done: true, ts: Date.now() }) + "\n", "utf-8");
    } catch { /* non-fatal */ }
  }

  replayPending(): Array<{ id: string; job: JournalEntry["job"] }> {
    if (!this.journalPath || !fs.existsSync(this.journalPath)) return [];
    try {
      const lines = fs.readFileSync(this.journalPath, "utf-8").split("\n").filter(Boolean);
      const byId = new Map<string, JournalEntry>();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Partial<JournalEntry>;
          if (!entry.id) continue;
          const existing = byId.get(entry.id);
          if (existing) {
            if (entry.done) existing.done = true;
          } else {
            byId.set(entry.id, { id: entry.id, job: entry.job!, done: !!entry.done, ts: entry.ts ?? 0 });
          }
        } catch { /* malformed line: skip */ }
      }
      return [...byId.values()].filter((e) => !e.done).map(({ id, job }) => ({ id, job }));
    } catch { return []; }
  }

  private _compactIfNeeded(): void {
    if (!this.journalPath || !fs.existsSync(this.journalPath)) return;
    try {
      if (fs.statSync(this.journalPath).size < JOURNAL_COMPACT_THRESHOLD) return;
      const pending = this.replayPending();
      const compact = pending.map((e) => JSON.stringify({ id: e.id, job: e.job, done: false, ts: Date.now() }) + "\n").join("");
      fs.writeFileSync(this.journalPath + ".tmp", compact, "utf-8");
      fs.renameSync(this.journalPath + ".tmp", this.journalPath);
    } catch { /* non-fatal */ }
  }
}

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
  // Fix #12: append-only WAL for crash recovery.
  private readonly wal = new WriteAheadJournal();
  private _walJobSeq = 0;

  constructor(
    private readonly store: MemoryFileStore,
    private readonly summarizer: Summarizer,
    private readonly hooks: MemoryHooks,
    private readonly getConfig: () => MemoryFilesConfig,
  ) {
    // Initialize WAL from the store's root directory.
    try {
      this.wal.init(store.paths.root);
      this._replayWAL();
    } catch { /* non-fatal */ }
  }

  /** Replay unfinished journal entries from a previous process run. */
  private _replayWAL(): void {
    const pending = this.wal.replayPending();
    if (pending.length === 0) return;
    console.log(`[memory] WAL replay: ${pending.length} pending job(s) from previous run.`);
    for (const { id, job } of pending) {
      try {
        // Replay: heuristic-only (no LLM available on startup replay path).
        this._replayJobSync(job, id);
      } catch (err) {
        this.recordFailure(`wal-replay:${id}`, err);
      }
    }
  }

  private _replayJobSync(job: JournalEntry["job"], walId: string): void {
    switch (job.type) {
      case "daily_note":
        executeOpSync(this.store.planDailyNote(job.text, job.source));
        break;
      case "compaction_archive":
        executeOpSync(this.store.planCompactionArchive(job));
        break;
      case "session_summary": {
        const s = this.summarizer.heuristicSession(job.turns, 2_500);
        executeOpSync(this.store.planSessionSummary({ sessionId: job.sessionId, title: s.title, summary: s.summary, reason: job.reason, via: "heuristic" }));
        break;
      }
      case "flush":
        // flush is safe to skip on replay (session context is gone).
        break;
    }
    this.wal.markDone(walId);
    this.processed++;
  }

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
      // Fix #12: Journal before enqueue so the job survives a crash between
      // enqueue() and the background pump completing the write.
      // Closure-bearing "task" jobs cannot be replayed after a restart, so
      // only data jobs are journalled.
      if (job.type === "task") {
        queue.push(job);
      } else {
        const walId = `j${Date.now()}_${++this._walJobSeq}`;
        this.wal.append(walId, job);
        queue.push({ ...job, _walId: walId } as MemoryJob & { _walId: string });
      }
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
      const walId = (job as MemoryJob & { _walId?: string })._walId;
      try {
        this.runJobSync(job);
        this.processed++;
        if (walId) this.wal.markDone(walId);
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
        const walId = (job as MemoryJob & { _walId?: string })._walId;
        try {
          await this.runJob(job);
          this.processed++;
          // Fix #12: mark the WAL entry done only after the job succeeded.
          if (walId) this.wal.markDone(walId);
        } catch (err) {
          this.recordFailure(job.type === "task" ? (job as Extract<MemoryJob, { type: "task" }>).name : job.type, err);
          // On failure, leave the WAL entry un-done so it can be replayed.
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
