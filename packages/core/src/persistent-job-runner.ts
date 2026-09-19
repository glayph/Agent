import {
  PersistentJobQueue,
  type PersistentJob,
} from "./persistent-job-queue.js";

export type PersistentJobHandler = (
  job: PersistentJob,
  signal: AbortSignal,
) => Promise<unknown>;

export interface PersistentJobRunnerOptions {
  pollIntervalMs?: number;
  maxConcurrent?: number;
  leaseDurationMs?: number;
  workerId?: string;
}

export interface PersistentJobRunnerStatus {
  running: boolean;
  workerId: string;
  activeJobs: number;
  processed: number;
  succeeded: number;
  failed: number;
  leaseLosses: number;
  lastError?: string;
  lastTickAt?: string;
}

/**
 * A small process-local worker around the durable queue. The queue recovers
 * expired running jobs on boot; this runner leases, heartbeats, completes and
 * fails them with bounded concurrency. Handlers should remain idempotent.
 */
export class PersistentJobRunner {
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly leaseDurationMs: number;
  private readonly workerId: string;
  private readonly handlers = new Map<string, PersistentJobHandler>();
  private readonly controllers = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private status: PersistentJobRunnerStatus;

  constructor(
    private readonly queue: PersistentJobQueue,
    options: PersistentJobRunnerOptions = {},
  ) {
    this.pollIntervalMs = normalizeInt(options.pollIntervalMs, 500, 10, 60_000);
    this.maxConcurrent = normalizeInt(options.maxConcurrent, 1, 1, 32);
    this.leaseDurationMs = normalizeInt(
      options.leaseDurationMs,
      30_000,
      1_000,
      24 * 60 * 60 * 1_000,
    );
    this.workerId =
      options.workerId?.trim() ||
      process.env.MIKI_WORKER_ID?.trim() ||
      `worker-${process.pid}`;
    this.status = {
      running: false,
      workerId: this.workerId,
      activeJobs: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      leaseLosses: 0,
    };
  }

  register(type: string, handler: PersistentJobHandler): void {
    const normalized = type.trim();
    if (!normalized) throw new Error("job handler type is required");
    this.handlers.set(normalized, handler);
  }

  start(): void {
    if (this.timer) return;
    this.status.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.status.running = false;
    for (const controller of this.controllers.values()) controller.abort();
    while (this.ticking || this.controllers.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  getStatus(): PersistentJobRunnerStatus {
    return {
      ...this.status,
      activeJobs: this.controllers.size,
    };
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.status.lastTickAt = new Date().toISOString();
    try {
      while (this.controllers.size < this.maxConcurrent) {
        const job = this.queue.dequeue(
          Date.now(),
          this.workerId,
          this.leaseDurationMs,
        );
        if (!job) break;
        const handler = this.handlers.get(job.type);
        if (!handler) {
          this.queue.fail(
            job.id,
            new Error(`No handler registered for ${job.type}`),
            0,
            this.workerId,
          );
          this.status.failed += 1;
          continue;
        }
        const controller = new AbortController();
        this.controllers.set(job.id, controller);
        void this.execute(job, handler, controller);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async execute(
    job: PersistentJob,
    handler: PersistentJobHandler,
    controller: AbortController,
  ): Promise<void> {
    const heartbeatMs = Math.max(500, Math.floor(this.leaseDurationMs / 3));
    const heartbeat = setInterval(() => {
      const refreshed = this.queue.heartbeat(
        job.id,
        this.workerId,
        this.leaseDurationMs,
      );
      if (!refreshed) {
        this.status.leaseLosses += 1;
        controller.abort(new Error(`Lease lost for job ${job.id}`));
      }
    }, heartbeatMs);
    try {
      const result = await handler(job, controller.signal);
      const completed = this.queue.complete(job.id, result, this.workerId);
      if (!completed) {
        this.status.leaseLosses += 1;
        throw new Error(`Lease lost before completing job ${job.id}`);
      }
      this.status.succeeded += 1;
    } catch (error: unknown) {
      const failed = this.queue.fail(job.id, error, 60_000, this.workerId);
      if (!failed) this.status.leaseLosses += 1;
      else this.status.failed += 1;
      this.status.lastError =
        error instanceof Error ? error.message : String(error);
    } finally {
      clearInterval(heartbeat);
      this.status.processed += 1;
      this.controllers.delete(job.id);
      void this.tick();
    }
  }
}

function normalizeInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
