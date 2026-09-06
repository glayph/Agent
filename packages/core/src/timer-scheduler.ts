import * as fs from "node:fs";
import * as path from "node:path";
import { PersistentJobQueue } from "./persistent-job-queue.js";
import { parseCronToNextRun } from "./scheduler.js";

export interface PersistentTimer {
  id: string;
  sessionId: string;
  message: string;
  schedule: string;
  nextRunAt: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastEnqueuedAt?: number;
}

interface TimerFile {
  version: 1;
  timers: PersistentTimer[];
}

function readTimers(filePath: string): Map<string, PersistentTimer> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as TimerFile;
    return new Map(
      (Array.isArray(parsed.timers) ? parsed.timers : []).map((timer) => [
        timer.id,
        timer,
      ]),
    );
  } catch {
    return new Map();
  }
}

export class PersistentTimerScheduler {
  private readonly timers: Map<string, PersistentTimer>;
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string,
    private readonly jobs: PersistentJobQueue,
    private readonly intervalMs = 1_000,
  ) {
    this.timers = readTimers(filePath);
  }

  list(): PersistentTimer[] {
    return [...this.timers.values()].sort((a, b) => a.nextRunAt - b.nextRunAt);
  }

  create(input: {
    sessionId: string;
    message: string;
    schedule: string;
    idempotencyKey?: string;
  }): PersistentTimer {
    if (!input.sessionId.trim()) throw new Error("sessionId is required");
    if (!input.message.trim()) throw new Error("message is required");
    const nextRunAt = parseCronToNextRun(input.schedule);
    if (nextRunAt === null)
      throw new Error(`Unsupported schedule expression: ${input.schedule}`);
    const now = Date.now();
    const timer: PersistentTimer = {
      id: `timer_${now}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: input.sessionId,
      message: input.message,
      schedule: input.schedule.trim(),
      nextRunAt,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.timers.set(timer.id, timer);
    this.persist();
    return timer;
  }

  cancel(id: string): boolean {
    const timer = this.timers.get(id);
    if (!timer) return false;
    timer.enabled = false;
    timer.updatedAt = Date.now();
    this.persist();
    return true;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  private tick(): void {
    const now = Date.now();
    let changed = false;
    for (const timer of this.timers.values()) {
      if (!timer.enabled || timer.nextRunAt > now) continue;
      const runAt = timer.nextRunAt;
      const nextRunAt = parseCronToNextRun(timer.schedule, runAt);
      if (nextRunAt === null) {
        timer.enabled = false;
        timer.updatedAt = now;
        changed = true;
        continue;
      }
      this.jobs.enqueue(
        "agent.message",
        {
          message: timer.message,
          sessionId: timer.sessionId,
          timerId: timer.id,
          scheduledAt: runAt,
        },
        { idempotencyKey: `timer:${timer.id}:${runAt}` },
      );
      timer.lastEnqueuedAt = now;
      timer.nextRunAt = nextRunAt;
      timer.updatedAt = now;
      changed = true;
    }
    if (changed) this.persist();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: TimerFile = { version: 1, timers: this.list() };
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(temp, this.filePath);
  }
}
