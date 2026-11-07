import { randomUUID } from "node:crypto";
import type { DurableTask, DurableTaskStore } from "./task-store.js";
import { classifyTaskError, type TaskErrorCategory } from "./task-errors.js";

/** Pure retry-delay resolver shared by the worker and deterministic regression tests. */
export function calculateDurableTaskRetryDelayMs(
  attemptCount: number,
  retryBaseMs: number,
  retryMaxMs: number,
  category: TaskErrorCategory,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined) return Math.max(1, Math.min(86_400_000, Math.floor(retryAfterMs)));
  const maxDelay = Math.max(1, Math.floor(retryMaxMs));
  const baseDelay = Math.min(maxDelay, Math.max(0, Math.floor(retryBaseMs)));
  const exponent = Math.min(30, Math.max(0, Math.floor(attemptCount) - 1));
  const exponentialDelay = Math.min(maxDelay, baseDelay * (2 ** exponent));
  const randomValue = Math.min(1, Math.max(0, Number(random()) || 0));
  const jitteredDelay = Math.min(maxDelay, Math.max(1, Math.floor(exponentialDelay * (0.8 + randomValue * 0.4))));
  return category === "resource_exhaustion"
    ? Math.min(86_400_000, Math.max(jitteredDelay, maxDelay))
    : jitteredDelay;
}

export interface DurableTaskWorkerOptions {
  pollMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  /** Maximum time stop() waits for cooperative handlers; 0 means wait indefinitely. */
  shutdownGraceMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxConcurrency?: number;
  /** Dynamic ceiling; lowering it never interrupts already-running tasks. */
  getMaxConcurrency?: () => number;
  taskType?: string;
  workerId?: string;
  now?: () => string;
  onError?: (error: unknown) => void;
  onSettled?: (task: DurableTask) => Promise<void> | void;
  /** Task-specific acceptance check. Required when a task has verificationSpec. */
  verifier?: DurableTaskVerifier;
}

export interface TaskVerificationOutcome {
  passed: boolean;
  evidence?: Record<string, unknown>;
  reason?: string;
  retryable?: boolean;
  errorCategory?: TaskErrorCategory;
}

export type DurableTaskVerifier = (
  task: DurableTask,
  result: string | undefined,
  signal: AbortSignal,
) => Promise<TaskVerificationOutcome> | TaskVerificationOutcome;

export type DurableTaskHandler = (
  task: DurableTask,
  signal: AbortSignal,
  checkpoint: (value: Record<string, unknown>, progress?: number) => void,
) => Promise<{ result?: string; status?: "completed" | "cancelled" } | void>;

/**
 * Durable queue worker. Claim/lease transitions are fenced by a unique lease
 * token; cancellation is polled with the heartbeat; shutdown releases active
 * claims back to the queue without consuming an attempt.
 */
export class DurableTaskWorker {
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly shutdownGraceMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxConcurrency: number;
  private readonly getMaxConcurrency?: () => number;
  private readonly verifier?: DurableTaskVerifier;
  private readonly taskType: string;
  private readonly workerId: string;
  private readonly now: () => string;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly active = new Map<string, AbortController>();
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>();
  /** Claims abandoned after shutdown grace must never commit late handler results. */
  private readonly abandonedByShutdown = new Set<string>();
  private shuttingDown = false;
  private readonly pending = new Set<Promise<DurableTask | null>>();
  private consecutiveLoopFailures = 0;
  private lastLoopErrorAt: string | null = null;
  private loopSleepTimer: ReturnType<typeof setTimeout> | null = null;
  private loopSleepResolve: (() => void) | null = null;
  private loopRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private loopGeneration = 0;
  private loopRestartAttempt = 0;
  private loopRestartCount = 0;

  private notifyError(error: unknown): void {
    try { this.onError?.(error); } catch { /* diagnostics must never stop the durable worker */ }
  }

  private reportLoopError(error: unknown): void {
    this.consecutiveLoopFailures = Math.min(30, this.consecutiveLoopFailures + 1);
    try { this.lastLoopErrorAt = this.now(); } catch { this.lastLoopErrorAt = null; }
    this.notifyError(error);
  }

  private sleepLoop(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        if (this.loopSleepTimer) clearTimeout(this.loopSleepTimer);
        this.loopSleepTimer = null;
        this.loopSleepResolve = null;
        resolve();
      };
      this.loopSleepResolve = finish;
      this.loopSleepTimer = setTimeout(finish, ms);
      (this.loopSleepTimer as unknown as { unref?: () => void }).unref?.();
    });
  }

  private wakeLoop(): void {
    this.loopSleepResolve?.();
  }

  status(): { running: boolean; active_tasks: number; pending_tasks: number; consecutive_loop_failures: number; last_loop_error_at: string | null; loop_restart_pending: boolean; loop_restart_attempt: number; loop_restart_count: number } {
    return {
      running: this.running,
      active_tasks: this.active.size,
      pending_tasks: this.pending.size,
      consecutive_loop_failures: this.consecutiveLoopFailures,
      last_loop_error_at: this.lastLoopErrorAt,
      loop_restart_pending: this.loopRestartTimer !== null,
      loop_restart_attempt: this.loopRestartAttempt,
      loop_restart_count: this.loopRestartCount,
    };
  }

  private loopDelayMs(): number {
    if (this.consecutiveLoopFailures === 0) return this.pollMs;
    return Math.min(60_000, Math.max(this.pollMs, 500 * (2 ** Math.min(this.consecutiveLoopFailures - 1, 7))));
  }

  constructor(
    private readonly store: DurableTaskStore,
    private readonly handler: DurableTaskHandler,
    options: DurableTaskWorkerOptions = {},
  ) {
    this.pollMs = Math.max(25, options.pollMs ?? 500);
    this.leaseMs = Math.max(100, options.leaseMs ?? 60_000);
    this.heartbeatMs = Math.max(10, Math.min(this.leaseMs - 1, options.heartbeatMs ?? Math.floor(this.leaseMs / 3)));
    this.shutdownGraceMs = Number.isFinite(options.shutdownGraceMs) ? Math.max(0, Math.floor(options.shutdownGraceMs!)) : 0;
    this.retryBaseMs = Math.max(0, options.retryBaseMs ?? 1_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 60_000);
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 1));
    this.getMaxConcurrency = options.getMaxConcurrency;
    this.verifier = options.verifier;
    this.taskType = options.taskType ?? "tracked_run";
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onError = options.onError;
    this.onSettled = options.onSettled;
  }

  private readonly onError?: (error: unknown) => void;
  private readonly onSettled?: (task: DurableTask) => Promise<void> | void;

  private async settled(task: DurableTask): Promise<DurableTask> {
    if (["completed", "failed", "cancelled", "superseded", "blocked", "needs_reconciliation"].includes(task.status)) {
      try { await this.onSettled?.(task); } catch (error) { this.notifyError(error); }
    }
    return task;
  }

  private concurrencyLimit(): number {
    try {
      const dynamic = this.getMaxConcurrency?.();
      if (typeof dynamic === "number" && Number.isFinite(dynamic)) {
        return Math.max(0, Math.min(this.maxConcurrency, Math.floor(dynamic)));
      }
    } catch (error) {
      this.notifyError(error);
    }
    return this.maxConcurrency;
  }

  private async finishCooperativeShutdown(taskId: string, leaseToken: string): Promise<DurableTask | null> {
    if (this.abandonedByShutdown.has(taskId)) return null;
    const latest = this.store.get(taskId);
    if (!latest || latest.leaseToken !== leaseToken || !latest.leaseExpiresAt || latest.leaseExpiresAt <= this.now()) return latest ?? null;
    if (latest.cancelRequestedAt) {
      return this.settled(this.store.transition(taskId, "cancelled", {
        now: this.now(), reason: "task cancellation was requested during worker shutdown", leaseToken,
      }));
    }
    // A cooperative handler has stopped. Release the lease immediately; any
    // in-flight side effect remains in the action ledger and is reconciled
    // before another worker is allowed to execute this task.
    return this.store.releaseClaim(taskId, leaseToken, this.now(), "cooperative worker shutdown; task safely requeued");
  }

  private retryDelay(attemptCount: number, category: TaskErrorCategory, retryAfterMs?: number): number {
    return calculateDurableTaskRetryDelayMs(attemptCount, this.retryBaseMs, this.retryMaxMs, category, retryAfterMs);
  }

  async runOnce(): Promise<DurableTask | null> {
    const timestamp = this.now();
    this.store.reconcileHierarchy(timestamp);
    const recovered = this.store.recoverExpired(timestamp, { taskType: this.taskType });
    for (const item of recovered) await this.settled(item);
    const task = this.store.claimNext(timestamp, this.leaseMs, { taskType: this.taskType, workerId: this.workerId });
    if (!task) return null;

    const leaseToken = task.leaseToken;
    if (!leaseToken) throw new Error(`Claimed task ${task.taskId} has no lease token.`);
    const unsettledAtClaim = this.store.listUnsettledActions(task.taskId);
    if (unsettledAtClaim.length) {
      const names = [...new Set(unsettledAtClaim.map((action) => action.toolName))].join(", ");
      return this.settled(this.store.transition(task.taskId, "needs_reconciliation", {
        now: this.now(), reason: "task has an uncertain external action from an earlier attempt",
        error: `Unconfirmed external actions: ${names}. Reconcile their external state before continuing.`,
        errorCategory: "uncertain_side_effect", leaseToken,
      }));
    }
    const controller = new AbortController();
    this.active.set(task.taskId, controller);
    const heartbeat = setInterval(() => {
      const latest = this.store.get(task.taskId);
      if (latest?.cancelRequestedAt) {
        controller.abort(new Error("Task cancellation requested."));
        return;
      }
      if (!this.store.renewLease(task.taskId, this.now(), this.leaseMs, leaseToken)) {
        controller.abort(new Error("Task lease lost; worker must not commit a stale result."));
      }
    }, this.heartbeatMs);
    (heartbeat as { unref?: () => void }).unref?.();
    this.heartbeats.set(task.taskId, heartbeat);

    try {
      // Task lifetime has no inactivity deadline. The lease heartbeat proves worker
      // ownership; process loss lets the durable lease expire and be recovered later.
      // Checkpoints record resumable progress but never act as a clock-based stop rule.
      const output = await this.handler(task, controller.signal, (checkpoint, progress) => {
        const saved = this.store.updateProgress(task.taskId, { checkpoint, ...(progress !== undefined ? { progress } : {}), now: this.now(), leaseToken });
        if (!saved) throw new Error("Task lease was lost or cancellation was requested while saving the checkpoint.");
      });
      if (this.shuttingDown && controller.signal.aborted) return this.finishCooperativeShutdown(task.taskId, leaseToken);
      const latest = this.store.get(task.taskId);
      if (controller.signal.aborted || latest?.cancelRequestedAt) {
        if (latest?.cancelRequestedAt) {
          return this.settled(this.store.transition(task.taskId, "cancelled", {
            now: this.now(), reason: "background job cancelled by the owner", leaseToken,
          }));
        }
        return this.store.releaseClaim(task.taskId, leaseToken, this.now());
      }
      if (output && typeof output === "object" && output.status === "cancelled") {
        return this.settled(this.store.transition(task.taskId, "cancelled", {
          now: this.now(), reason: "background agent run was cancelled", leaseToken,
        }));
      }
      const resultText = output && typeof output === "object" ? output.result : undefined;
      this.store.transition(task.taskId, "verifying", {
        now: this.now(), reason: "handler returned; running completion verification", leaseToken,
        ...(resultText !== undefined ? { result: resultText } : {}),
      });
      const unsettledBeforeVerify = this.store.listUnsettledActions(task.taskId);
      if (unsettledBeforeVerify.length) {
        const names = [...new Set(unsettledBeforeVerify.map((action) => action.toolName))].join(", ");
        return this.settled(this.store.transition(task.taskId, "needs_reconciliation", {
          now: this.now(), reason: "external actions remain unsettled after handler completion",
          error: `Unconfirmed external actions: ${names}. Reconcile their external state before continuing.`,
          errorCategory: "uncertain_side_effect",
          leaseToken,
        }));
      }
      if (task.verificationSpec && !this.verifier) {
        return this.settled(this.store.transition(task.taskId, "blocked", {
          now: this.now(), reason: "task acceptance criteria cannot be evaluated because no verifier is configured",
          error: "A task-specific verifier is required before this task can be marked completed.",
          errorCategory: "auth_config",
          leaseToken,
        }));
      }
      const verification = this.verifier
        ? await this.verifier(task, resultText, controller.signal)
        : {
            passed: true,
            evidence: {
              method: "handler_resolution",
              handlerResolved: true,
              noUnsettledExternalActions: true,
              note: "No task-specific acceptance criteria were supplied; this confirms handler completion, not external-world state.",
            },
          };
      if (this.shuttingDown && controller.signal.aborted) return this.finishCooperativeShutdown(task.taskId, leaseToken);
      const latestAfterVerify = this.store.get(task.taskId);
      if (controller.signal.aborted || latestAfterVerify?.cancelRequestedAt) {
        if (latestAfterVerify?.cancelRequestedAt) {
          return this.settled(this.store.transition(task.taskId, "cancelled", {
            now: this.now(), reason: "task cancelled during completion verification", leaseToken,
          }));
        }
        return this.store.releaseClaim(task.taskId, leaseToken, this.now());
      }
      if (!verification.passed) {
        const category = verification.errorCategory ?? "permanent_validation";
        const reason = verification.reason ?? "Acceptance verification failed.";
        const evidence = { passed: false, ...(verification.evidence ? { evidence: verification.evidence } : {}) };
        if (category === "cancelled") {
          return this.settled(this.store.transition(task.taskId, "cancelled", {
            now: this.now(), reason, error: reason, errorCategory: category, leaseToken,
            verificationResult: evidence,
          }));
        }
        if (category === "uncertain_side_effect") {
          return this.settled(this.store.transition(task.taskId, "needs_reconciliation", {
            now: this.now(), reason, error: reason, errorCategory: category, leaseToken,
            verificationResult: evidence,
          }));
        }
        const retryable = verification.retryable === true
          || ["transient", "rate_limit", "stale_state", "resource_exhaustion"].includes(category);
        if (retryable && !(task.maxAttempts > 0 && task.attemptCount >= task.maxAttempts)) {
          const delayMs = this.retryDelay(task.attemptCount, category);
          return this.store.transition(task.taskId, "retrying", {
            now: this.now(), reason, error: reason, errorCategory: category,
            nextRetryAt: new Date(Date.parse(this.now()) + delayMs).toISOString(), leaseToken,
            verificationResult: evidence,
          });
        }
        if (retryable && task.maxAttempts > 0 && task.attemptCount >= task.maxAttempts) {
          return this.settled(this.store.transition(task.taskId, "failed", {
            now: this.now(), reason: `verification failed after ${task.attemptCount}/${task.maxAttempts} attempts: ${reason}`,
            error: reason, errorCategory: category, leaseToken, verificationResult: evidence,
          }));
        }
        return this.settled(this.store.transition(task.taskId, "blocked", {
          now: this.now(), reason, error: reason, errorCategory: category, leaseToken,
          verificationResult: evidence,
        }));
      }
      return this.settled(this.store.transition(task.taskId, "completed", {
        now: this.now(), reason: "completion verification passed", leaseToken,
        ...(resultText !== undefined ? { result: resultText } : {}),
        verificationResult: { passed: true, ...(verification.evidence ? { evidence: verification.evidence } : {}) },
      }));
    } catch (error) {
      if (this.shuttingDown && controller.signal.aborted) return this.finishCooperativeShutdown(task.taskId, leaseToken);
      const message = error instanceof Error ? error.message : String(error);
      const latest = this.store.get(task.taskId);
      if (!latest || latest.leaseToken !== leaseToken) {
        this.notifyError(error);
        return latest;
      }
      if (latest.leaseExpiresAt && latest.leaseExpiresAt <= this.now()) {
        // An expired owner may observe the failure, but only recovery/reclaim may
        // transition the task from this point onward.
        this.notifyError(error);
        return latest;
      }
      if (latest.cancelRequestedAt) {
        return this.settled(this.store.transition(task.taskId, "cancelled", {
          now: this.now(), reason: "background job cancelled by the owner", leaseToken,
        }));
      }
      if (controller.signal.aborted) {
        // Shutdown or lease loss is not a job failure. Return it to the queue;
        // releaseClaim restores the attempt counter so deployments do not burn retries.
        try { return this.store.releaseClaim(task.taskId, leaseToken, this.now()); }
        catch (releaseError) { this.notifyError(releaseError); return this.store.get(task.taskId); }
      }
      this.notifyError(error);
      const unsettledAfterFailure = this.store.listUnsettledActions(task.taskId);
      if (unsettledAfterFailure.length) {
        const names = [...new Set(unsettledAfterFailure.map((action) => action.toolName))].join(", ");
        return this.settled(this.store.transition(task.taskId, "needs_reconciliation", {
          now: this.now(), reason: "handler failed while an external action remained uncertain",
          error: `Unconfirmed external actions: ${names}. Reconcile their external state before continuing.`,
          errorCategory: "uncertain_side_effect", leaseToken,
        }));
      }
      const classified = classifyTaskError(error);
      if (classified.category === "cancelled") {
        return this.settled(this.store.transition(task.taskId, "cancelled", {
          now: this.now(), reason: "handler reported cancellation", error: message,
          errorCategory: classified.category, leaseToken,
        }));
      }
      if (classified.category === "uncertain_side_effect") {
        return this.settled(this.store.transition(task.taskId, "needs_reconciliation", {
          now: this.now(), reason: "an external side effect may have completed without a confirmed result",
          error: message, errorCategory: classified.category, leaseToken,
        }));
      }
      if (["auth_config", "permanent_validation"].includes(classified.category)) {
        return this.settled(this.store.transition(task.taskId, "blocked", {
          now: this.now(), reason: `task blocked by ${classified.category} error`, error: message,
          errorCategory: classified.category, leaseToken,
        }));
      }
      if (task.maxAttempts > 0 && task.attemptCount >= task.maxAttempts) {
        return this.settled(this.store.transition(task.taskId, "failed", {
          now: this.now(), reason: `worker handler failed after ${task.attemptCount}/${task.maxAttempts} attempts`,
          error: message, errorCategory: classified.category, leaseToken,
        }));
      }
      const delayMs = this.retryDelay(task.attemptCount, classified.category, classified.retryAfterMs);
      const nextRetryAt = new Date(Date.parse(this.now()) + delayMs).toISOString();
      const attemptLabel = task.maxAttempts > 0 ? `${task.attemptCount + 1}/${task.maxAttempts}` : `${task.attemptCount + 1} (unbounded)`;
      const recoveryAction = classified.category === "stale_state" ? "re-observe and refresh stale state" : "retry after backoff";
      return this.store.transition(task.taskId, "retrying", {
        now: this.now(), reason: `${classified.category}: ${recoveryAction}; retry ${attemptLabel} scheduled after ${delayMs}ms`,
        error: message, errorCategory: classified.category, nextRetryAt, leaseToken,
      });
    } finally {
      clearInterval(heartbeat);
      this.heartbeats.delete(task.taskId);
      this.active.delete(task.taskId);
      this.abandonedByShutdown.delete(task.taskId);
    }
  }

  start(): Promise<void> {
    if (this.loopPromise) return this.loopPromise;
    this.running = true;
    this.shuttingDown = false;
    this.loopRestartAttempt = 0;
    this.launchLoop();
    return this.loopPromise ?? Promise.resolve();
  }

  /** Start or recover the poll loop. The generation fence prevents stale exits restarting a stopped worker. */
  private launchLoop(): void {
    if (!this.running || this.loopPromise) return;
    if (this.loopRestartTimer) {
      clearTimeout(this.loopRestartTimer);
      this.loopRestartTimer = null;
    }
    const generation = ++this.loopGeneration;
    const loop = this.runLoop();
    this.loopPromise = loop;
    void loop.then(
      () => this.handleUnexpectedLoopExit(generation, loop),
      (error) => this.handleUnexpectedLoopExit(generation, loop, error),
    );
  }

  private handleUnexpectedLoopExit(generation: number, loop: Promise<void>, error?: unknown): void {
    if (this.loopPromise === loop) this.loopPromise = null;
    if (!this.running || generation !== this.loopGeneration) return;
    this.reportLoopError(error ?? new Error("Durable task worker poll loop exited while still active."));
    this.loopRestartAttempt = Math.min(30, this.loopRestartAttempt + 1);
    this.loopRestartCount += 1;
    const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(this.loopRestartAttempt - 1, 6)));
    this.loopRestartTimer = setTimeout(() => {
      this.loopRestartTimer = null;
      if (!this.running || generation !== this.loopGeneration) return;
      this.launchLoop();
    }, delayMs);
    (this.loopRestartTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let started = 0;
      let queueEmpty = false;
      let cycleFailed = false;
      try {
        while (this.running && !queueEmpty && this.pending.size < this.concurrencyLimit()) {
          const pending = this.runOnce();
          this.pending.add(pending);
          pending.then((task) => {
            this.consecutiveLoopFailures = 0;
            if (!task) queueEmpty = true;
          }, (error) => {
            queueEmpty = true;
            cycleFailed = true;
            this.reportLoopError(error);
          }).finally(() => this.pending.delete(pending)).catch((error) => this.notifyError(error));
          started += 1;
          // runOnce claims synchronously before its first await. Fill bounded concurrency
          // slots without waiting for active jobs; idle workers never spin at full CPU.
          if (started >= this.maxConcurrency) break;
          await Promise.resolve();
        }
        // Let an immediately rejected claim settle before choosing the next poll delay,
        // so persistent database failures use exponential backoff instead of hot polling.
        await Promise.resolve();
        if (!started || queueEmpty || this.pending.size >= this.concurrencyLimit()) {
          await this.sleepLoop(cycleFailed ? this.loopDelayMs() : this.pollMs);
        }
      } catch (error) {
        // Database/lease/store failures must not leave running=true with a dead loop.
        cycleFailed = true;
        this.reportLoopError(error);
        await this.sleepLoop(this.loopDelayMs());
      }
      if (!cycleFailed) {
        this.consecutiveLoopFailures = 0;
        this.loopRestartAttempt = 0;
      }
    }
    await Promise.allSettled([...this.pending]);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.shuttingDown = true;
    this.loopGeneration += 1;
    if (this.loopRestartTimer) {
      clearTimeout(this.loopRestartTimer);
      this.loopRestartTimer = null;
    }
    this.wakeLoop();
    const loop = this.loopPromise;
    this.active.forEach((controller) => controller.abort(new Error("Worker is shutting down.")));
    const drain = Promise.allSettled([...this.pending]);
    if (this.shutdownGraceMs > 0 && this.pending.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        drain.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.shutdownGraceMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!drained) {
        // Do not perform any further store writes for these handlers. Their lease
        // is deliberately allowed to expire; the next worker reconciles any
        // action-ledger entries before it can retry them.
        for (const taskId of this.active.keys()) this.abandonedByShutdown.add(taskId);
        for (const heartbeat of this.heartbeats.values()) clearInterval(heartbeat);
        this.notifyError(new Error(`Worker shutdown grace expired with ${this.active.size} task(s) still running; their leases will expire and be recovered on restart.`));
        return;
      }
    } else {
      await drain;
    }
    await loop;
  }
}
