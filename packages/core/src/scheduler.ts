/**
 * Task Scheduler - Background task queue processor
 * Handles task scheduling, prioritization, and lifecycle management
 */

import { TaskQueue, AgentTask } from "./task-queue.js";
import { ConcurrentTaskManager } from "./concurrent-manager.js";
import { sessionTurnLock } from "./session-turn-lock.js";

export interface ScheduledTask {
  id: string;
  sessionId: string;
  message: string;
  cronExpression?: string;
  intervalMs?: number;
  timezone?: string;
  missedRunPolicy?: "run_once" | "skip" | "catch_up";
  timeoutMs?: number;
  quietHours?: { start: string; end: string; timezone?: string };
  concurrencyLimit?: number;
  executionToken?: string;
  title?: string;
  resultSummary?: string;
  artifactRefs?: string[];
  notificationSentAt?: number;
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
  missedRuns?: number;
  catchUpRemaining?: number;
  heartbeatAt?: number;
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
  timezone?: string;
  missedRunPolicy?: ScheduledTask["missedRunPolicy"];
  quietHours?: ScheduledTask["quietHours"];
  perTaskConcurrencyLimit?: number;
}

export interface ScheduleOptions {
  maxAttempts?: number;
  intervalMs?: number;
  timezone?: string;
  missedRunPolicy?: ScheduledTask["missedRunPolicy"];
  timeoutMs?: number;
  quietHours?: ScheduledTask["quietHours"];
  concurrencyLimit?: number;
  title?: string;
  artifactRefs?: string[];
}

export interface TaskCompletionNotification {
  taskId: string;
  sessionId: string;
  title: string;
  status: "succeeded" | "failed" | "dead_letter";
  resultSummary?: string;
  errorSummary?: string;
  artifactRefs: string[];
  retryCommand: string;
  durationMs: number;
  completedAt: number;
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
  timezone = "UTC",
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
    const MIN_SECONDS_INTERVAL = 30;
    return seconds >= MIN_SECONDS_INTERVAL ? time + seconds * 1000 : null;
  }

  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length === 5) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
      return null;
    }
    const matches = (field: string, value: number, min: number, max: number) =>
      field.split(",").some((part) => {
        if (part === "*") return true;
        const step = part.match(/^\*\/(\d+)$/);
        if (step)
          return Number(step[1]) > 0 && (value - min) % Number(step[1]) === 0;
        const range = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
        if (range) {
          const start = Number(range[1]);
          const end = Number(range[2]);
          const increment = Number(range[3] || 1);
          return (
            value >= start && value <= end && (value - start) % increment === 0
          );
        }
        const numeric = Number(part);
        return (
          Number.isInteger(numeric) &&
          numeric >= min &&
          numeric <= max &&
          numeric === value
        );
      });
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    for (
      let candidate = Math.floor(time / 60_000) * 60_000 + 60_000;
      candidate <= time + 366 * 24 * 60 * 60_000;
      candidate += 60_000
    ) {
      const parts = Object.fromEntries(
        formatter
          .formatToParts(candidate)
          .map((part) => [part.type, part.value]),
      );
      const minute = Number(parts.minute);
      const hour = Number(parts.hour);
      const day = Number(parts.day);
      const month = Number(parts.month);
      const weekday = weekdayMap[parts.weekday];
      if (
        matches(fields[0], minute, 0, 59) &&
        matches(fields[1], hour, 0, 23) &&
        matches(fields[2], day, 1, 31) &&
        matches(fields[3], month, 1, 12) &&
        matches(fields[4], weekday, 0, 6)
      )
        return candidate;
    }
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
  private _wakeTimer: NodeJS.Timeout | null = null;
  private _onSlotReleased = (): void => {
    if (this._intervalId) this._scheduleWake(0);
  };
  private static readonly MIN_WAKE_MS = 250;
  private static readonly MAX_WAKE_MS = 30_000;
  private _executeTask: (
    sessionId: string,
    message: string,
    task?: AgentTask,
  ) => AsyncGenerator<string, void, unknown>;
  private _scheduledTasks: Map<string, ScheduledTask> = new Map();
  private _recoveredPersistedTasks = false;
  private _lastHeartbeatAt = 0;
  private _missedRuns = 0;
  private _activeScheduledRuns = new Map<string, number>();
  private _completionNotifier?: (
    notification: TaskCompletionNotification,
  ) => void | Promise<void>;
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
    completionNotifier?: (
      notification: TaskCompletionNotification,
    ) => void | Promise<void>,
  ) {
    this._taskQueue =
      taskQueue || new TaskQueue({ maxSize: config.taskQueueSize ?? 50 });
    this._concurrentManager =
      concurrentManager ||
      new ConcurrentTaskManager(config.maxConcurrentTasks ?? 3);
    this._executeTask = executeTask || async function* () {};
    this._completionNotifier = completionNotifier;
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
    // Marker: a non-null _intervalId means "running". Actual scheduling now
    // uses an adaptive setTimeout (_wakeTimer) rather than a fixed-interval
    // setInterval, so we don't burn CPU polling an empty/idle task set.
    this._intervalId = setInterval(() => {}, TaskScheduler.MAX_WAKE_MS);
    this._concurrentManager.on("release", this._onSlotReleased);
    this._processPendingTasks();
  }

  stop(): void {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    if (this._wakeTimer) {
      clearTimeout(this._wakeTimer);
      this._wakeTimer = null;
    }
    this._concurrentManager.off("release", this._onSlotReleased);
  }

  heartbeat(): void {
    this._lastHeartbeatAt = Date.now();
    if (this._intervalId) this._processPendingTasks();
  }

  /** (Re)arms the wake timer for the earliest of: an explicit delay, or the
   * soonest pending scheduled task's runAt. Coalesces multiple callers
   * (schedule(), release events, post-run rescheduling) into one timer. */
  private _scheduleWake(explicitDelayMs?: number): void {
    if (!this._intervalId) return;
    if (this._wakeTimer) {
      clearTimeout(this._wakeTimer);
      this._wakeTimer = null;
    }
    const now = Date.now();
    let delay =
      explicitDelayMs !== undefined
        ? explicitDelayMs
        : TaskScheduler.MAX_WAKE_MS;
    if (explicitDelayMs === undefined) {
      for (const task of this._scheduledTasks.values()) {
        if (task.status !== "pending" || task.runAt === undefined) continue;
        delay = Math.min(delay, Math.max(0, task.runAt - now));
      }
      // Non-scheduled queued tasks waiting for capacity should be picked up
      // promptly too; the "release" event handles the common case, but a
      // task enqueued while already at capacity still needs a bound.
      if (
        this._taskQueue.getPendingTasks().length > 0 &&
        !this._concurrentManager.isAtCapacity()
      ) {
        delay = 0;
      }
    }
    delay = Math.min(
      TaskScheduler.MAX_WAKE_MS,
      Math.max(explicitDelayMs === 0 ? 0 : TaskScheduler.MIN_WAKE_MS, delay),
    );
    this._wakeTimer = setTimeout(() => {
      this._wakeTimer = null;
      this._processPendingTasks();
    }, delay);
  }

  schedule(
    sessionId: string,
    message: string,
    cronExpression?: string,
    runAt?: number,
    options: ScheduleOptions = {},
  ): ScheduledTask {
    if (!sessionId.trim()) throw new Error("sessionId is required.");
    if (!message.trim()) throw new Error("message is required.");
    validateScheduledRunAt(runAt);

    const now = Date.now();
    const normalizedCron = normalizeCronExpression(cronExpression);
    const timezone = options.timezone ?? this.config.timezone ?? "UTC";
    const intervalMs =
      options.intervalMs !== undefined
        ? Math.max(1_000, Math.floor(options.intervalMs))
        : undefined;
    const nextCronRun = normalizedCron
      ? parseCronToNextRun(normalizedCron, Date.now(), timezone)
      : null;
    if (normalizedCron && nextCronRun === null && intervalMs === undefined) {
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
      intervalMs,
      timezone,
      missedRunPolicy:
        options.missedRunPolicy ?? this.config.missedRunPolicy ?? "run_once",
      timeoutMs:
        options.timeoutMs !== undefined
          ? Math.max(1_000, Math.floor(options.timeoutMs))
          : this.config.execTimeoutMinutes && this.config.execTimeoutMinutes > 0
            ? this.config.execTimeoutMinutes * 60_000
            : undefined,
      quietHours: options.quietHours ?? this.config.quietHours,
      concurrencyLimit: Math.max(
        1,
        options.concurrencyLimit ?? this.config.perTaskConcurrencyLimit ?? 1,
      ),
      executionToken: `run_${now}_${Math.random().toString(36).slice(2, 10)}`,
      title: options.title ?? message.split("\n", 1)[0].trim().slice(0, 120),
      artifactRefs: [...(options.artifactRefs ?? [])],
      runAt: runAt ?? nextCronRun ?? (intervalMs ? now + intervalMs : now),
      status: "pending",
      attempts: 0,
      maxAttempts,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    this._scheduledTasks.set(scheduled.id, scheduled);
    this._store?.upsertTask(scheduled);
    this._scheduleWake();
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
        if (task.runAt !== undefined && task.runAt < now) {
          task.missedRuns = (task.missedRuns ?? 0) + 1;
          task.lastError = "Recovered missed scheduled run";
          task.updatedAt = now;
          this._missedRuns++;
          if (task.missedRunPolicy === "skip") {
            task.runAt = this._nextRunAfter(task, now);
            task.lastError = "Skipped missed scheduled run by policy";
          } else if (task.missedRunPolicy === "catch_up") {
            task.catchUpRemaining = Math.max(
              0,
              this._countMissedRuns(task, now) - 1,
            );
            task.runAt = now;
            task.lastError = `Catching up ${task.catchUpRemaining + 1} missed scheduled run(s)`;
          }
          this._store.upsertTask(task);
        }
        this._scheduledTasks.set(task.id, task);
      }
    }

    this._stats.recovered += recovered;
    return recovered;
  }

  private _processPendingTasks(): void {
    const now = Date.now();
    this._lastHeartbeatAt = now;
    for (const [id, scheduled] of this._scheduledTasks.entries()) {
      if (this._concurrentManager.isAtCapacity()) break;
      if (scheduled.status !== "pending") continue;
      if (!scheduled.runAt || scheduled.runAt > now) continue;
      if (
        (this._activeScheduledRuns.get(id) ?? 0) >=
        (scheduled.concurrencyLimit ?? 1)
      )
        continue;
      if (this._isQuietHours(scheduled, now)) {
        scheduled.runAt = now + 60_000;
        scheduled.lastError = "Deferred by quiet hours";
        scheduled.updatedAt = now;
        this._store?.upsertTask(scheduled);
        continue;
      }

      scheduled.status = "running";
      scheduled.lastRunAt = now;
      scheduled.updatedAt = now;
      this._activeScheduledRuns.set(
        id,
        (this._activeScheduledRuns.get(id) ?? 0) + 1,
      );
      this._store?.upsertTask(scheduled);
      this._runScheduledTask(id, scheduled);
    }

    while (!this._concurrentManager.isAtCapacity()) {
      const task = this._taskQueue.dequeue();
      if (!task) break;

      this._stats.dequeued++;
      this._runQueuedTask(task);
    }

    this._scheduleWake();
  }

  private async _runScheduledTask(
    id: string,
    scheduled: ScheduledTask,
  ): Promise<void> {
    const timeoutMs =
      scheduled.timeoutMs ??
      (this.config.execTimeoutMinutes && this.config.execTimeoutMinutes > 0
        ? this.config.execTimeoutMinutes * 60_000
        : undefined);

    // Acquire the session lock before the executor's generator is even
    // created, so a channel message (or another scheduled/queued task) for
    // this same sessionId can never start a turn while this one is
    // in-flight. The lock is released below only once `consume` truly
    // settles - including the case where we've already moved on due to a
    // timeout but the abandoned executor is still running in the
    // background (see the comment on `consume` for why that can happen).
    const release = await sessionTurnLock.acquire(scheduled.sessionId);

    const iterator = this._executeTask(scheduled.sessionId, scheduled.message);
    let timedOut = false;
    let resultSummary = "";

    // Consume the generator on its own promise so it can be raced against
    // the timeout below. A cooperative "check a flag inside the loop body"
    // approach (the previous implementation) only re-checks the flag when
    // the generator yields — an executor that hangs on a single internal
    // await (agent loop stuck on a tool call, a network request, etc.)
    // never yields again, so that check is never reached and the timeout
    // never fires. Racing the whole consumption promise against a timer
    // bounds it unconditionally, regardless of whether/when the executor
    // yields.
    const consume = (async () => {
      for await (const chunk of iterator) {
        if (typeof chunk === "string" && chunk.trim())
          resultSummary = chunk.trim().slice(-1200);
        if (timedOut) break;
      }
    })();
    // If we time out below, `consume` is abandoned but keeps running in
    // the background until the executor itself eventually settles. Attach
    // a no-op catch now so that eventual rejection can't surface as an
    // unhandled promise rejection once we've already moved on.
    consume.catch(() => {});
    // Release the session lock once the executor (abandoned or not) is
    // actually done touching session state - not when we merely stop
    // waiting on it below. `.finally()` re-throws whatever `consume` threw,
    // and nothing else awaits this particular chain, so it needs its own
    // no-op catch (separate from the one above) or a rejection here would
    // surface as an unhandled promise rejection.
    void consume.finally(() => release()).catch(() => {});

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      if (timeoutMs !== undefined) {
        const timeoutPromise = new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        });
        await Promise.race([consume, timeoutPromise]);
      } else {
        await consume;
      }

      if (!this._scheduledTasks.has(id)) return;

      if (timedOut) {
        // Best-effort cancellation: ask the executor's async generator to
        // stop at its next suspension point. This can't forcibly interrupt
        // a stuck `await` (e.g. a hung network call), but it does let any
        // `finally` cleanup in the executor run once/if it resumes, and we
        // never wait on it ourselves either way.
        void iterator.return?.(undefined)?.catch?.(() => {});
        this._markScheduledFailure(
          id,
          scheduled,
          new Error(
            `Scheduled task timed out after ${timeoutMs}ms.`,
          ),
        );
        this._stats.failed++;
        return;
      }

      this._markScheduledSuccess(id, scheduled, resultSummary);
      this._stats.processed++;
    } catch (err: unknown) {
      if (!this._scheduledTasks.has(id)) return;
      this._markScheduledFailure(id, scheduled, err);
      this._stats.failed++;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const active = this._activeScheduledRuns.get(id) ?? 1;
      if (active <= 1) this._activeScheduledRuns.delete(id);
      else this._activeScheduledRuns.set(id, active - 1);
      if (!this._scheduledTasks.has(id)) return;

      if (this._isTerminalStatus(scheduled.status)) {
        this._scheduledTasks.delete(id);
      }
      // A run just finished (success reschedules runAt, failure sets a
      // retry runAt, or a capacity slot is now free either way) - rearm so
      // the next due time is picked up without waiting on a fixed poll.
      this._scheduleWake();
    }
  }

  private _markScheduledSuccess(
    id: string,
    scheduled: ScheduledTask,
    resultSummary = "",
  ): void {
    const now = Date.now();
    scheduled.status = "completed";
    scheduled.lastError = null;
    scheduled.resultSummary = resultSummary || undefined;
    scheduled.updatedAt = now;
    this._emitCompletion(
      scheduled,
      "succeeded",
      resultSummary || undefined,
      undefined,
      now,
    );

    if (scheduled.cronExpression || scheduled.intervalMs) {
      if ((scheduled.catchUpRemaining ?? 0) > 0) {
        scheduled.catchUpRemaining -= 1;
        scheduled.status = "pending";
        scheduled.runAt = now;
        scheduled.attempts = 0;
        scheduled.completedAt = undefined;
        scheduled.notificationSentAt = undefined;
        this._store?.upsertTask(scheduled);
        return;
      }
      const nextRun = this._nextRunAfter(scheduled, now);
      if (nextRun) {
        scheduled.status = "pending";
        scheduled.runAt = nextRun;
        scheduled.attempts = 0;
        scheduled.completedAt = undefined;
        scheduled.notificationSentAt = undefined;
        scheduled.executionToken = `run_${now}_${Math.random().toString(36).slice(2, 10)}`;
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
      this._scheduleWake();
      return;
    }

    scheduled.status = "dead_letter";
    scheduled.completedAt = now;
    this._stats.deadLettered++;
    this._emitCompletion(
      scheduled,
      "dead_letter",
      scheduled.resultSummary,
      errorMsg,
      now,
    );
    this._store?.upsertTask(scheduled);
    this._scheduledTasks.delete(id);
  }

  private _emitCompletion(
    task: ScheduledTask,
    status: "succeeded" | "dead_letter",
    resultSummary: string | undefined,
    errorSummary: string | undefined,
    completedAt: number,
  ): void {
    if (!this._completionNotifier || task.notificationSentAt) return;
    task.notificationSentAt = completedAt;
    this._store?.upsertTask(task);
    const notification: TaskCompletionNotification = {
      taskId: task.id,
      sessionId: task.sessionId,
      title: task.title || task.message.split("\n", 1)[0].slice(0, 120),
      status,
      ...(resultSummary ? { resultSummary } : {}),
      ...(errorSummary ? { errorSummary } : {}),
      artifactRefs: [...(task.artifactRefs ?? [])],
      retryCommand: `/retry ${task.id}`,
      durationMs: Math.max(0, completedAt - (task.lastRunAt ?? task.createdAt)),
      completedAt,
    };
    try {
      const result = this._completionNotifier(notification);
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch((error: unknown) => {
          console.warn("[Scheduler] completion notification failed:", error);
        });
      }
    } catch (error) {
      console.warn("[Scheduler] completion notification failed:", error);
    }
  }

  private _retryDelayMs(attempts: number): number {
    const base = this.config.retryBaseDelayMs ?? 60_000;
    const max = this.config.retryMaxDelayMs ?? 15 * 60_000;
    return Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), max);
  }

  private _nextRunAfter(task: ScheduledTask, from: number): number {
    if (task.intervalMs) return from + task.intervalMs;
    if (task.cronExpression) {
      return (
        parseCronToNextRun(
          task.cronExpression,
          from,
          task.timezone ?? this.config.timezone ?? "UTC",
        ) ?? from + 60_000
      );
    }
    return from + 60_000;
  }

  private _countMissedRuns(task: ScheduledTask, now: number): number {
    const maxCatchUp = 100;
    if (task.intervalMs && task.runAt !== undefined) {
      return Math.min(
        maxCatchUp,
        Math.max(1, Math.floor((now - task.runAt) / task.intervalMs) + 1),
      );
    }
    if (task.cronExpression && task.runAt !== undefined) {
      let count = 1;
      let cursor = task.runAt;
      while (count < maxCatchUp) {
        const next = parseCronToNextRun(
          task.cronExpression,
          cursor,
          task.timezone ?? this.config.timezone ?? "UTC",
        );
        if (!next || next > now) break;
        count += 1;
        cursor = next;
      }
      return count;
    }
    return 1;
  }

  private _isQuietHours(task: ScheduledTask, now: number): boolean {
    const quiet = task.quietHours;
    if (!quiet) return false;
    const [startHour, startMinute] = quiet.start.split(":").map(Number);
    const [endHour, endMinute] = quiet.end.split(":").map(Number);
    if (![startHour, startMinute, endHour, endMinute].every(Number.isFinite))
      return false;
    let parts: Record<string, string>;
    try {
      parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone:
            quiet.timezone ?? task.timezone ?? this.config.timezone ?? "UTC",
          hour: "numeric",
          minute: "numeric",
          hourCycle: "h23",
        })
          .formatToParts(now)
          .map((part) => [part.type, part.value]),
      );
    } catch {
      return false;
    }
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    return start === end
      ? true
      : start < end
        ? minute >= start && minute < end
        : minute >= start || minute < end;
  }

  private _isTerminalStatus(status: ScheduledTask["status"]): boolean {
    return (
      status === "completed" ||
      status === "cancelled" ||
      status === "dead_letter"
    );
  }

  private async _runQueuedTask(task: AgentTask): Promise<void> {
    const release = await sessionTurnLock.acquire(task.sessionId);
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
    } finally {
      release();
    }
  }

  getHeartbeatStatus(): {
    running: boolean;
    lastHeartbeatAt: number;
    missedRuns: number;
    nextBackoffMs: number;
  } {
    return {
      running: this._intervalId !== null,
      lastHeartbeatAt: this._lastHeartbeatAt,
      missedRuns: this._missedRuns,
      nextBackoffMs: this._retryDelayMs(1),
    };
  }

  getHealthMetrics(): {
    healthy: boolean;
    running: boolean;
    lastHeartbeatAt: number;
    heartbeatAgeMs: number;
    missedRuns: number;
    deadLettered: number;
    activeTasks: number;
    queuedTasks: number;
    scheduledTasks: number;
    lastError?: string;
  } {
    const now = Date.now();
    const history = this.getScheduledTaskHistory(1)[0];
    const heartbeatAgeMs = this._lastHeartbeatAt
      ? now - this._lastHeartbeatAt
      : Number.POSITIVE_INFINITY;
    return {
      healthy:
        this.isRunning() &&
        heartbeatAgeMs <=
          Math.max(
            5_000,
            (this.config.schedulerIntervalMs ?? TaskScheduler.MAX_WAKE_MS) *
              10,
          ),
      running: this.isRunning(),
      lastHeartbeatAt: this._lastHeartbeatAt,
      heartbeatAgeMs,
      missedRuns: this._missedRuns,
      deadLettered: this._stats.deadLettered,
      activeTasks: this._concurrentManager.activeCount,
      queuedTasks: this._taskQueue.getPendingTasks().length,
      scheduledTasks: this.getScheduledTasks().length,
      ...(history?.lastError ? { lastError: history.lastError } : {}),
    };
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
