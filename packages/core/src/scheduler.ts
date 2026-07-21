/**
 * Task Scheduler - Background task queue processor
 * Handles task scheduling, prioritization, and lifecycle management
 */

import { TaskQueue, AgentTask } from "./task-queue.js";
import { ConcurrentTaskManager } from "./concurrent-manager.js";

export interface ScheduledTask {
  id: string;
  sessionId: string;
  message: string;
  cronExpression?: string;
  runAt?: number;
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "dead_letter";
  attempts: number;
  maxAttempts: number;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  completedAt?: number;
}

export interface SchedulerConfig {
  maxConcurrentTasks?: number;
  taskQueueSize?: number;
  schedulerIntervalMs?: number;
  enableTaskPersistence?: boolean;
  maxScheduledTaskAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  recoveryStaleAfterMs?: number;
  execTimeoutMinutes?: number;
}

export interface ScheduledTaskStore {
  loadActiveTasks(): ScheduledTask[];
  loadRecentTasks(limit?: number): ScheduledTask[];
  loadTask(id: string): ScheduledTask | undefined;
  upsertTask(task: ScheduledTask): void;
}

function normalizeCronExpression(cronExpression?: string): string | undefined {
  if (cronExpression === undefined) return undefined;
  const normalized = cronExpression.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function validateScheduledRunAt(runAt?: number): void {
  if (runAt === undefined) return;
  if (!Number.isSafeInteger(runAt) || runAt < 0) {
    throw new Error("runAt must be a non-negative safe integer timestamp.");
  }
}

function validateMaxAttempts(maxAttempts: number): void {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive safe integer.");
  }
}

/**
 * Cron expression parser (simplified - supports basic patterns)
 */
export function parseCronToNextRun(
  cronExpr: string,
  fromTime?: number,
): number | null {
  const time = fromTime || Date.now();

  if (cronExpr === "@hourly") return time + 60 * 60 * 1000;
  if (cronExpr === "@daily") return time + 24 * 60 * 60 * 1000;
  if (cronExpr === "@weekly") return time + 7 * 24 * 60 * 60 * 1000;

  const minuteMatch = cronExpr.match(/every\s+(\d+)\s+minutes?/i);
  if (minuteMatch) {
    const minutes = parseInt(minuteMatch[1], 10);
    return minutes > 0 ? time + minutes * 60 * 1000 : null;
  }

  const secondMatch = cronExpr.match(/every\s+(\d+)\s+seconds?/i);
  if (secondMatch) {
    const seconds = parseInt(secondMatch[1], 10);
    return seconds > 0 ? time + seconds * 1000 : null;
  }

  return null;
}

/**
 * TaskScheduler provides background processing for queued tasks
 * Designed to be used by AgentOrchestrator - executeTask is passed in
 */
export class TaskScheduler {
  private _taskQueue: TaskQueue;
  private _concurrentManager: ConcurrentTaskManager;
  private _intervalId: NodeJS.Timeout | null = null;
  private _executeTask: (
    sessionId: string,
    message: string,
    task?: AgentTask,
  ) => AsyncGenerator<string, void, unknown>;
  private _scheduledTasks: Map<string, ScheduledTask> = new Map();
  private _recoveredPersistedTasks = false;
  private _stats = {
    processed: 0,
    failed: 0,
    dequeued: 0,
    recovered: 0,
    retried: 0,
    deadLettered: 0,
  };

  constructor(
    private config: SchedulerConfig,
    taskQueue?: TaskQueue,
    concurrentManager?: ConcurrentTaskManager,
    executeTask?: (
      sessionId: string,
      message: string,
      task?: AgentTask,
    ) => AsyncGenerator<string, void, unknown>,
    private _store?: ScheduledTaskStore,
  ) {
    this._taskQueue =
      taskQueue || new TaskQueue({ maxSize: config.taskQueueSize ?? 50 });
    this._concurrentManager =
      concurrentManager ||
      new ConcurrentTaskManager(config.maxConcurrentTasks ?? 3);
    this._executeTask = executeTask || async function* () {};
  }

  setTaskExecutor(
    executor: (
      sessionId: string,
      message: string,
      task?: AgentTask,
    ) => AsyncGenerator<string, void, unknown>,
  ): void {
    this._executeTask = executor;
  }

  get taskQueue(): TaskQueue {
    return this._taskQueue;
  }

  get concurrentManager(): ConcurrentTaskManager {
    return this._concurrentManager;
  }

  start(): void {
    if (this._intervalId) return;

    this.recoverPersistedTasks();
    const interval = this.config.schedulerIntervalMs ?? 100;
    this._intervalId = setInterval(() => this._processPendingTasks(), interval);
  }

  stop(): void {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  schedule(
    sessionId: string,
    message: string,
    cronExpression?: string,
    runAt?: number,
    options: { maxAttempts?: number } = {},
  ): ScheduledTask {
    if (!sessionId.trim()) throw new Error("sessionId is required.");
    if (!message.trim()) throw new Error("message is required.");
    validateScheduledRunAt(runAt);

    const now = Date.now();
    const normalizedCron = normalizeCronExpression(cronExpression);
    const nextCronRun = normalizedCron
      ? parseCronToNextRun(normalizedCron)
      : null;
    if (normalizedCron && nextCronRun === null) {
      throw new Error(`Unsupported schedule expression: ${normalizedCron}`);
    }
    const maxAttempts =
      options.maxAttempts ?? this.config.maxScheduledTaskAttempts ?? 3;
    validateMaxAttempts(maxAttempts);

    const scheduled: ScheduledTask = {
      id: `scheduled_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      message,
      cronExpression: normalizedCron,
      runAt: runAt ?? nextCronRun ?? now,
      status: "pending",
      attempts: 0,
      maxAttempts,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    this._scheduledTasks.set(scheduled.id, scheduled);
    this._store?.upsertTask(scheduled);
    return scheduled;
  }

  cancelScheduled(id: string): boolean {
    const task = this._scheduledTasks.get(id) ?? this._store?.loadTask(id);
    if (!task || this._isTerminalStatus(task.status)) return false;

    task.status = "cancelled";
    task.completedAt = Date.now();
    task.updatedAt = task.completedAt;
    this._store?.upsertTask(task);
    this._scheduledTasks.delete(id);
    return true;
  }

  getScheduledTasks(): ScheduledTask[] {
    return Array.from(this._scheduledTasks.values()).filter(
      (t) => t.status === "pending" || t.status === "running",
    );
  }

  getScheduledTaskHistory(limit?: number): ScheduledTask[] {
    return (
      this._store?.loadRecentTasks(limit) ?? [...this._scheduledTasks.values()]
    );
  }

  getScheduledTask(id: string): ScheduledTask | undefined {
    return this._scheduledTasks.get(id) ?? this._store?.loadTask(id);
  }

  recoverPersistedTasks(): number {
    if (this._recoveredPersistedTasks || !this._store) return 0;
    this._recoveredPersistedTasks = true;

    const now = Date.now();
    let recovered = 0;

    for (const task of this._store.loadActiveTasks()) {
      if (task.status === "running") {
        task.status = "pending";
        task.lastError = "Recovered after scheduler restart";
        task.updatedAt = now;
        recovered++;
        this._store.upsertTask(task);
      }
      if (task.status === "pending") {
        this._scheduledTasks.set(task.id, task);
      }
    }

    this._stats.recovered += recovered;
    return recovered;
  }

  private _processPendingTasks(): void {
    const now = Date.now();
    for (const [id, scheduled] of this._scheduledTasks.entries()) {
      if (this._concurrentManager.isAtCapacity()) break;
      if (scheduled.status !== "pending") continue;
      if (!scheduled.runAt || scheduled.runAt > now) continue;

      scheduled.status = "running";
      scheduled.lastRunAt = now;
      scheduled.updatedAt = now;
      this._store?.upsertTask(scheduled);
      this._runScheduledTask(id, scheduled);
    }

    while (!this._concurrentManager.isAtCapacity()) {
      const task = this._taskQueue.dequeue();
      if (!task) return;

      this._stats.dequeued++;
      this._runQueuedTask(task);
    }
  }

  private async _runScheduledTask(
    id: string,
    scheduled: ScheduledTask,
  ): Promise<void> {
    const timeoutMs =
      this.config.execTimeoutMinutes && this.config.execTimeoutMinutes > 0
        ? this.config.execTimeoutMinutes * 60_000
        : undefined;
    const abortController = timeoutMs ? new AbortController() : undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (abortController && timeoutMs) {
      timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of this._executeTask(
        scheduled.sessionId,
        scheduled.message,
      )) {
        // Consume the generator to completion
        if (abortController?.signal.aborted) break;
      }
      if (!this._scheduledTasks.has(id)) return;
      this._markScheduledSuccess(id, scheduled);
      this._stats.processed++;
    } catch (err: unknown) {
      if (!this._scheduledTasks.has(id)) return;
      this._markScheduledFailure(id, scheduled, err);
      this._stats.failed++;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (!this._scheduledTasks.has(id)) return;

      if (scheduled.status === "pending" || scheduled.status === "running") {
        if (abortController?.signal.aborted) {
          this._markScheduledFailure(
            id,
            scheduled,
            new Error(
              `Scheduled task timed out after ${this.config.execTimeoutMinutes} minutes.`,
            ),
          );
          this._stats.failed++;
        }
        return;
      }

      if (this._isTerminalStatus(scheduled.status)) {
        this._scheduledTasks.delete(id);
      }
    }
  }

  private _markScheduledSuccess(id: string, scheduled: ScheduledTask): void {
    const now = Date.now();
    scheduled.status = "completed";
    scheduled.lastError = null;
    scheduled.updatedAt = now;

    if (scheduled.cronExpression) {
      const nextRun = parseCronToNextRun(scheduled.cronExpression, now);
      if (nextRun) {
        scheduled.status = "pending";
        scheduled.runAt = nextRun;
        scheduled.attempts = 0;
        scheduled.completedAt = undefined;
        this._store?.upsertTask(scheduled);
        return;
      }
    }

    scheduled.completedAt = now;
    this._store?.upsertTask(scheduled);
    this._scheduledTasks.delete(id);
  }

  private _markScheduledFailure(
    id: string,
    scheduled: ScheduledTask,
    err: unknown,
  ): void {
    const now = Date.now();
    const errorMsg = err instanceof Error ? err.message : String(err);
    scheduled.status = "failed";
    scheduled.attempts += 1;
    scheduled.lastError = errorMsg;
    scheduled.updatedAt = now;

    if (scheduled.attempts < scheduled.maxAttempts) {
      scheduled.status = "pending";
      scheduled.runAt = now + this._retryDelayMs(scheduled.attempts);
      this._stats.retried++;
      this._store?.upsertTask(scheduled);
      return;
    }

    scheduled.status = "dead_letter";
    scheduled.completedAt = now;
    this._stats.deadLettered++;
    this._store?.upsertTask(scheduled);
    this._scheduledTasks.delete(id);
  }

  private _retryDelayMs(attempts: number): number {
    const base = this.config.retryBaseDelayMs ?? 60_000;
    const max = this.config.retryMaxDelayMs ?? 15 * 60_000;
    return Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), max);
  }

  private _isTerminalStatus(status: ScheduledTask["status"]): boolean {
    return (
      status === "completed" ||
      status === "cancelled" ||
      status === "dead_letter"
    );
  }

  private async _runQueuedTask(task: AgentTask): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of this._executeTask(
        task.sessionId,
        task.message,
        task,
      )) {
        // Consume the generator
      }
      if (task.status === "running") {
        this._taskQueue.complete(task.id);
        this._stats.processed++;
      }
    } catch (err: unknown) {
      console.error("[Scheduler] Background task error:", err);
      if (task.status === "running") {
        this._taskQueue.fail(
          task.id,
          err instanceof Error ? err.message : String(err),
        );
        this._stats.failed++;
      }
    }
  }

  getStats(): {
    processed: number;
    failed: number;
    dequeued: number;
    recovered: number;
    retried: number;
    deadLettered: number;
    activeTasks: number;
    waitingTasks: number;
    scheduledTasks: number;
    scheduledHistory: number;
  } {
    return {
      ...this._stats,
      activeTasks: this._concurrentManager.activeCount,
      waitingTasks: this._concurrentManager.waitingCount,
      scheduledTasks: this.getScheduledTasks().length,
      scheduledHistory: this.getScheduledTaskHistory(1000).length,
    };
  }

  getTaskStatuses(): {
    queued: AgentTask[];
    running: AgentTask[];
    completed: AgentTask[];
  } {
    return {
      queued: this._taskQueue.getPendingTasks(),
      running: this._taskQueue.getRunningTasks(),
      completed: this._taskQueue.getCompletedTasks().slice(-20),
    };
  }

  isRunning(): boolean {
    return this._intervalId !== null;
  }
}
