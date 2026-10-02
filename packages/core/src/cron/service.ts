/**
 * CronScheduler — persisted, restart-proof scheduled jobs (Step 09).
 */

import { randomUUID } from "node:crypto";
import type { CommandQueue } from "../command-queue/index.js";
import type { PersistentJobQueue } from "../persistent-job-queue.js";
import { waitForJob } from "../job-wait.js";
import { getLifecycleBus } from "../hooks/index.js";
import { computeNextRunAt, toIso } from "./schedule.js";
import { CronJobStore } from "./store.js";
import type {
  CronJob,
  CronJobInput,
  CronRunResult,
  MissedRunPolicy,
} from "./types.js";

export interface CronSchedulerOptions {
  stateDir: string;
  commandQueue?: CommandQueue;
  /** When set, cron fires enqueue real agent.message jobs. */
  jobQueue?: PersistentJobQueue;
  /**
   * Poll interval for due jobs (ms). Default 15_000.
   * Jobs still fire accurately relative to nextRunAt checks.
   */
  tickIntervalMs?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Optional: when wakeNow=false, delay execution until this returns true
   * (e.g. after heartbeat). Default: always run immediately when due.
   */
  shouldWake?: () => boolean;
}

export class CronScheduler {
  private readonly store: CronJobStore;
  private readonly commandQueue?: CommandQueue;
  private readonly jobQueue?: PersistentJobQueue;
  private readonly tickIntervalMs: number;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;
  private readonly shouldWake: () => boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking = false;

  constructor(options: CronSchedulerOptions) {
    this.store = new CronJobStore(options.stateDir);
    this.commandQueue = options.commandQueue;
    this.jobQueue = options.jobQueue;
    this.tickIntervalMs = options.tickIntervalMs ?? 15_000;
    this.log = options.log ?? ((m) => console.log(m));
    this.shouldWake = options.shouldWake ?? (() => true);
  }

  get storePath(): string {
    return this.store.path;
  }

  /** cron_add */
  add(input: CronJobInput): CronJob {
    const now = new Date().toISOString();
    const id = randomUUID();
    let nextMs = computeNextRunAt(input.schedule);
    // Past one-shot + run_on_load → fire on next tick
    if (
      nextMs === null &&
      input.schedule.kind === "once" &&
      (input.missedRunPolicy ?? "skip") === "run_on_load"
    ) {
      nextMs = Date.now();
    }
    const job: CronJob = {
      id,
      name: input.name.trim() || id.slice(0, 8),
      schedule: input.schedule,
      payload: input.payload,
      executionStyle: input.executionStyle ?? "isolated",
      deliveryTarget: input.deliveryTarget,
      deleteAfterRun: input.deleteAfterRun ?? input.schedule.kind === "once",
      missedRunPolicy: input.missedRunPolicy ?? "skip",
      wakeNow: input.wakeNow ?? true,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      nextRunAt: toIso(nextMs),
      runCount: 0,
    };
    this.store.upsert(job);
    this.log("[cron] added", { id: job.id, name: job.name, next: job.nextRunAt });
    return job;
  }

  /** cron_list */
  list(): CronJob[] {
    return this.store.list();
  }

  /** cron_remove */
  remove(jobId: string): boolean {
    const ok = this.store.remove(jobId);
    if (ok) this.log("[cron] removed", { id: jobId });
    return ok;
  }

  get(jobId: string): CronJob | undefined {
    return this.store.get(jobId);
  }

  /** Reload from disk (simulates process restart recovery). */
  reload(): void {
    this.store.reload();
    this.log("[cron] reloaded from disk", { count: this.store.list().length });
  }

  /**
   * cron_run — manually trigger a job now (does not wait for schedule).
   */
  async run(jobId: string): Promise<CronRunResult> {
    const job = this.store.get(jobId);
    if (!job) return { jobId, accepted: false, error: "job not found" };
    return this.executeJob(job, true);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.handleMissedOnLoad();
    this.log("[cron] scheduler started", {
      jobs: this.store.list().length,
      store: this.store.path,
    });
    this.scheduleTick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log("[cron] scheduler stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Test / ops: scan due jobs once. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const job of this.store.list()) {
        if (!job.enabled || !job.nextRunAt) continue;
        const due = Date.parse(job.nextRunAt);
        if (!Number.isFinite(due) || due > now) continue;
        if (!job.wakeNow && !this.shouldWake()) {
          this.log("[cron] due but waiting for wake", { id: job.id });
          continue;
        }
        await this.executeJob(job, false);
      }
    } finally {
      this.ticking = false;
    }
  }

  // ── internals ──────────────────────────────────────────

  private scheduleTick(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleTick());
    }, this.tickIntervalMs);
  }

  private handleMissedOnLoad(): void {
    const now = Date.now();
    for (const job of this.store.list()) {
      if (!job.enabled || !job.nextRunAt) continue;
      const due = Date.parse(job.nextRunAt);
      if (!Number.isFinite(due) || due > now) continue;
      const policy: MissedRunPolicy = job.missedRunPolicy ?? "skip";
      if (policy === "skip") {
        const nextMs = computeNextRunAt(job.schedule, now);
        job.nextRunAt = toIso(nextMs) ?? undefined;
        job.lastStatus = "skipped";
        job.updatedAt = new Date().toISOString();
        // one-shot missed + skip → remove or leave without next
        if (job.schedule.kind === "once" && !job.nextRunAt) {
          if (job.deleteAfterRun) {
            this.store.remove(job.id);
            this.log("[cron] missed one-shot skipped+deleted", { id: job.id });
            continue;
          }
        }
        this.store.upsert(job);
        this.log("[cron] missed run skipped", { id: job.id, next: job.nextRunAt });
      }
      // run_on_load: leave nextRunAt in the past so next tick executes
    }
  }

  private async executeJob(
    job: CronJob,
    manual: boolean,
  ): Promise<CronRunResult> {
    const session_key =
      job.executionStyle === "main"
        ? job.deliveryTarget?.trim() || "cron:main:system"
        : `cron:isolated:${job.id}`;

    this.log("[cron] running", {
      id: job.id,
      style: job.executionStyle,
      session_key,
      manual,
    });

    try {
      if (this.commandQueue) {
        await this.commandQueue.enqueue({
          session_key,
          message: job.payload,
          lane: job.executionStyle === "main" ? "main" : "subagent",
          mode: "followup",
          surface: "timer",
          payload: {
            cronJobId: job.id,
            cronName: job.name,
            executionStyle: job.executionStyle,
          },
          execute: async ({ signal }) => {
            if (signal.aborted) return;
            getLifecycleBus().emit("command:new", {
              source: "cron",
              jobId: job.id,
              session_key,
            });
            // Enqueue a real agent job when job queue is available.
            if (this.jobQueue) {
              const pj = this.jobQueue.enqueue("agent.message", {
                message: job.payload,
                sessionId: session_key,
                cronJobId: job.id,
                cronName: job.name,
                executionStyle: job.executionStyle,
              });
              await waitForJob(this.jobQueue, pj.id, {
                signal,
                timeoutMs: 600_000,
              });
              if (signal.aborted) {
                this.jobQueue.cancel(pj.id);
              }
            }
          },
        });
      } else if (this.jobQueue) {
        const pj = this.jobQueue.enqueue("agent.message", {
          message: job.payload,
          sessionId: session_key,
          cronJobId: job.id,
        });
        await waitForJob(this.jobQueue, pj.id, { timeoutMs: 600_000 });
        getLifecycleBus().emit("command:new", {
          source: "cron",
          jobId: job.id,
          session_key,
        });
      } else {
        getLifecycleBus().emit("command:new", {
          source: "cron",
          jobId: job.id,
          session_key,
        });
      }

      job.lastRunAt = new Date().toISOString();
      job.lastStatus = "ok";
      job.lastError = undefined;
      job.runCount += 1;
      job.updatedAt = job.lastRunAt;

      let deleted = false;
      if (job.deleteAfterRun && job.schedule.kind === "once") {
        this.store.remove(job.id);
        deleted = true;
        this.log("[cron] delete_after_run", { id: job.id });
        return { jobId: job.id, accepted: true, deleted, session_key };
      }

      // Advance schedule
      const from = Date.now();
      const nextMs = computeNextRunAt(job.schedule, from);
      job.nextRunAt = toIso(nextMs);
      if (job.schedule.kind === "once" && !job.nextRunAt) {
        job.enabled = false;
      }
      this.store.upsert(job);
      return { jobId: job.id, accepted: true, deleted, session_key };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      job.lastStatus = "error";
      job.lastError = message;
      job.updatedAt = new Date().toISOString();
      // still advance recurring so we don't tight-loop on errors
      if (job.schedule.kind === "cron") {
        job.nextRunAt = toIso(computeNextRunAt(job.schedule, Date.now())) ?? job.nextRunAt;
      }
      this.store.upsert(job);
      this.log("[cron] run error", { id: job.id, error: message });
      return { jobId: job.id, accepted: false, error: message, session_key };
    }
  }
}

// ── convenience API (cron_add / list / run / remove) ─────

let defaultScheduler: CronScheduler | null = null;

export function setDefaultCronScheduler(s: CronScheduler | null): void {
  defaultScheduler = s;
}

export function getDefaultCronScheduler(): CronScheduler | null {
  return defaultScheduler;
}

export function cron_add(input: CronJobInput): CronJob {
  if (!defaultScheduler) throw new Error("CronScheduler not initialized");
  return defaultScheduler.add(input);
}

export function cron_list(): CronJob[] {
  if (!defaultScheduler) throw new Error("CronScheduler not initialized");
  return defaultScheduler.list();
}

export async function cron_run(jobId: string): Promise<CronRunResult> {
  if (!defaultScheduler) throw new Error("CronScheduler not initialized");
  return defaultScheduler.run(jobId);
}

export function cron_remove(jobId: string): boolean {
  if (!defaultScheduler) throw new Error("CronScheduler not initialized");
  return defaultScheduler.remove(jobId);
}
