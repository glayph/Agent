import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { normalizeAgentError, type NormalizedAgentError } from "./errors.js";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "dead_letter";

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
  error?: NormalizedAgentError;
}

export interface EnqueueJobOptions {
  priority?: number;
  maxAttempts?: number;
  delayMs?: number;
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
    };
    this.jobs.set(job.id, job);
    this.save();
    return { ...job };
  }

  dequeue(now = Date.now()): PersistentJob | null {
    const job = [...this.jobs.values()]
      .filter((item) => item.status === "queued" && item.runAfter <= now)
      .sort((a, b) => b.priority - a.priority || a.runAfter - b.runAfter)[0];
    if (!job) return null;
    job.status = "running";
    job.attempts += 1;
    job.updatedAt = new Date().toISOString();
    this.save();
    return { ...job };
  }

  complete(jobId: string): PersistentJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.status = "completed";
    job.progress = 100;
    job.updatedAt = new Date().toISOString();
    this.save();
    return { ...job };
  }

  fail(
    jobId: string,
    error: unknown,
    retryDelayMs = 60_000,
  ): PersistentJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.error = normalizeAgentError(error);
    job.status = job.attempts >= job.maxAttempts ? "dead_letter" : "queued";
    job.runAfter = Date.now() + normalizeNonNegativeInt(retryDelayMs, 0);
    job.updatedAt = new Date().toISOString();
    this.save();
    return { ...job };
  }

  retry(jobId: string, delayMs = 0): PersistentJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (!["failed", "cancelled", "dead_letter"].includes(job.status)) {
      return null;
    }
    job.status = "queued";
    job.attempts = 0;
    job.progress = 0;
    job.runAfter = Date.now() + normalizeNonNegativeInt(delayMs, 0);
    job.error = undefined;
    job.updatedAt = new Date().toISOString();
    this.save();
    return { ...job };
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || ["completed", "dead_letter"].includes(job.status)) return false;
    job.status = "cancelled";
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
    for (const job of this.jobs.values()) {
      initial[job.status] += 1;
    }
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
          .map((job) => [job.id, job]),
      );
      let recovered = false;
      for (const job of this.jobs.values()) {
        if (job.status === "running") {
          job.status = "queued";
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
    typeof job.progress === "number"
  );
}
