import * as fs from "fs";
import * as path from "path";
import { normalizeAgentError, type NormalizedAgentError } from "./errors.js";

export type JobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "dead_letter";

export interface PersistentJobCheckpoint {
  id: string;
  step: string;
  status: "started" | "completed" | "failed";
  updatedAt: string;
  data?: Record<string, unknown>;
}

export interface PersistentJobRecovery {
  retryCount: number;
  deadLetteredAt?: string;
  lastRetryAt?: string;
  lastFailure?: NormalizedAgentError;
}

export interface PersistentJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  priority: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  runAfter: number;
  progress: number;
  idempotencyKey?: string;
  leaseOwner?: string;
  leaseUntil?: number;
  checkpoint?: PersistentJobCheckpoint;
  error?: NormalizedAgentError;
  result?: unknown;
  recovery: PersistentJobRecovery;
}

export interface EnqueueJobOptions {
  priority?: number;
  maxAttempts?: number;
  delayMs?: number;
  idempotencyKey?: string;
}

export interface ListJobsOptions {
  status?: JobStatus;
}

interface QueueFile {
  version: 1;
  jobs: PersistentJob[];
}

export class PersistentJobQueue {
  private readonly filePath: string;
  private jobs: Map<string, PersistentJob> = new Map();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.load();
  }

  enqueue(
    type: string,
    payload: Record<string, unknown>,
    options: EnqueueJobOptions = {},
  ): PersistentJob {
    const idempotencyKey = normalizeOptionalString(options.idempotencyKey);
    if (idempotencyKey) {
      const existing = [...this.jobs.values()].find(
        (job) =>
          job.idempotencyKey === idempotencyKey &&
          job.status !== "dead_letter" &&
          job.status !== "cancelled",
      );
      if (existing) return { ...existing };
    }

    const now = new Date().toISOString();
    const job: PersistentJob = {
      id: crypto.randomUUID(),
      type,
      payload,
      priority: options.priority ?? 0,
      status: "queued",
      attempts: 0,
      maxAttempts: normalizePositiveInt(options.maxAttempts, 3),
      createdAt: now,
      updatedAt: now,
      runAfter: Date.now() + normalizeNonNegativeInt(options.delayMs, 0),
      progress: 0,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      recovery: { retryCount: 0 },
    };
    this.jobs.set(job.id, job);
    this.save();
    return { ...job };
  }

  dequeue(
    now = Date.now(),
    workerId?: string,
    leaseDurationMs = 30_000,
  ): PersistentJob | null {
    const job = [...this.jobs.values()]
      .filter(
        (item) =>
          (item.status === "queued" && item.runAfter <= now) ||
          (item.status === "running" && (item.leaseUntil ?? 0) <= now),
      )
      .sort((a, b) => b.priority - a.priority || a.runAfter - b.runAfter)[0];
    if (!job) return null;
    job.status = "running";
    job.attempts += 1;
    if (workerId) {
      job.leaseOwner = workerId;
      job.leaseUntil = now + normalizePositiveInt(leaseDurationMs, 30_000);
    } else {
      job.leaseOwner = undefined;
      job.leaseUntil = undefined;
    }
    job.updatedAt = new Date().toISOString();
    this.save();
    return { ...job };
  }

  complete(
    jobId: string,
    result?: unknown,
    workerId?: string,
  ): PersistentJob | null {
    const job = this.jobs.get(jobId);
    if (!job || !this.ownsLease(job, workerId)) return null;
    job.status = "completed";
    job.progress = 100;
    job.leaseOwner = undefined;
    job.leaseUntil = undefined;
    if (result !== undefined) job.result = result;
    job.updatedAt = new Date().toISOString();
    this.save();
    return { ...job };
  }

  fail(
    jobId: string,
    error: unknown,
    retryDelayMs = 60_000,
    workerId?: string,
  ): PersistentJob | null {
    const job = this.jobs.get(jobId);
    if (!job || !this.ownsLease(job, workerId)) return null;
    const normalizedError = normalizeAgentError(error);
    job.error = normalizedError;
    job.recovery = {
      ...job.recovery,
      lastFailure: normalizedError,
      ...(job.attempts >= job.maxAttempts
        ? { deadLetteredAt: new Date().toISOString() }
        : {}),
    };
    job.status = job.attempts >= job.maxAttempts ? "dead_letter" : "queued";
    job.runAfter = Date.now() + normalizeNonNegativeInt(retryDelayMs, 0);
    job.leaseOwner = undefined;
    job.leaseUntil = undefined;
    job.updatedAt = new Date().toISOString();
    this.save();
    return { ...job };
  }

  heartbeat(
    jobId: string,
    workerId: string,
    leaseDurationMs = 30_000,
  ): PersistentJob | null {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running" || job.leaseOwner !== workerId) {
      return null;
    }
    job.leaseUntil = Date.now() + normalizePositiveInt(leaseDurationMs, 30_000);
    job.updatedAt = new Date().toISOString();
    this.save();
    return { ...job };
  }

  checkpoint(
    jobId: string,
    checkpoint: Omit<PersistentJobCheckpoint, "updatedAt">,
    workerId?: string,
  ): PersistentJob | null {
    const job = this.jobs.get(jobId);
    if (!job || !this.ownsLease(job, workerId)) return null;
    job.checkpoint = { ...checkpoint, updatedAt: new Date().toISOString() };
    job.updatedAt = job.checkpoint.updatedAt;
    this.save();
    return { ...job };
  }

  retry(jobId: string, delayMs = 0): PersistentJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (!["failed", "cancelled", "dead_letter"].includes(job.status)) {
      return null;
    }
    const previousError = job.error;
    const retriedAt = new Date().toISOString();
    job.status = "queued";
    job.attempts = 0;
    job.progress = 0;
    job.runAfter = Date.now() + normalizeNonNegativeInt(delayMs, 0);
    job.leaseOwner = undefined;
    job.leaseUntil = undefined;
    job.error = undefined;
    job.recovery = {
      ...job.recovery,
      retryCount: job.recovery.retryCount + 1,
      lastRetryAt: retriedAt,
      ...(previousError ? { lastFailure: previousError } : {}),
    };
    job.updatedAt = retriedAt;
    this.save();
    return { ...job };
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || ["completed", "dead_letter"].includes(job.status)) return false;
    job.status = "cancelled";
    job.leaseOwner = undefined;
    job.leaseUntil = undefined;
    job.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  updateProgress(jobId: string, progress: number): PersistentJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.progress = Math.max(0, Math.min(100, Math.round(progress)));
    job.updatedAt = new Date().toISOString();
    this.save();
    return { ...job };
  }

  list(options: ListJobsOptions = {}): PersistentJob[] {
    return [...this.jobs.values()]
      .filter((job) => !options.status || job.status === options.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((job) => ({ ...job }));
  }

  get(jobId: string): PersistentJob | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  deadLetters(): PersistentJob[] {
    return this.list({ status: "dead_letter" });
  }

  stats(): Record<JobStatus, number> {
    const initial: Record<JobStatus, number> = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      dead_letter: 0,
    };
    for (const job of this.jobs.values()) initial[job.status] += 1;
    return initial;
  }

  private load(): void {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf-8"),
      ) as QueueFile;
      this.jobs = new Map(
        (Array.isArray(parsed.jobs) ? parsed.jobs : [])
          .filter((job): job is PersistentJob => isPersistentJob(job))
          .map((job) => [job.id, normalizeLoadedJob(job)]),
      );
      let recovered = false;
      const now = Date.now();
      for (const job of this.jobs.values()) {
        if (
          job.status === "running" &&
          (!job.leaseUntil || job.leaseUntil <= now)
        ) {
          job.status = "queued";
          job.leaseOwner = undefined;
          job.leaseUntil = undefined;
          job.updatedAt = new Date().toISOString();
          recovered = true;
        }
      }
      if (recovered) this.save();
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      this.jobs = new Map();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const body: QueueFile = { version: 1, jobs: [...this.jobs.values()] };
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, this.filePath);
  }

  private ownsLease(job: PersistentJob, workerId?: string): boolean {
    return !workerId || !job.leaseOwner || job.leaseOwner === workerId;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function isPersistentJob(value: unknown): value is PersistentJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.id === "string" &&
    typeof job.type === "string" &&
    Boolean(job.payload && typeof job.payload === "object") &&
    typeof job.priority === "number" &&
    typeof job.status === "string" &&
    [
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      "dead_letter",
    ].includes(job.status) &&
    typeof job.attempts === "number" &&
    typeof job.maxAttempts === "number" &&
    typeof job.createdAt === "string" &&
    typeof job.updatedAt === "string" &&
    typeof job.runAfter === "number" &&
    typeof job.progress === "number" &&
    (job.recovery === undefined || isRecovery(job.recovery))
  );
}

function isRecovery(value: unknown): value is PersistentJobRecovery {
  if (!value || typeof value !== "object") return false;
  const recovery = value as Record<string, unknown>;
  return typeof recovery.retryCount === "number";
}

function normalizeLoadedJob(job: PersistentJob): PersistentJob {
  return {
    ...job,
    recovery: isRecovery(job.recovery) ? job.recovery : { retryCount: 0 },
  };
}
