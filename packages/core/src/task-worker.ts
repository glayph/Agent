import type { DurableTask, DurableTaskStore } from "./task-store.js";

export interface DurableTaskWorkerOptions {
  pollMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => string;
  onError?: (error: unknown) => void;
}

export type DurableTaskHandler = (
  task: DurableTask,
  signal: AbortSignal,
) => Promise<{ result?: string } | void>;

/**
 * Small, deterministic worker loop for persisted tasks. The worker owns only
 * claim/lease/terminal transitions; the handler owns the actual task work.
 */
export class DurableTaskWorker {
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => string;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly store: DurableTaskStore,
    private readonly handler: DurableTaskHandler,
    options: DurableTaskWorkerOptions = {},
  ) {
    this.pollMs = Math.max(10, options.pollMs ?? 1_000);
    this.leaseMs = Math.max(100, options.leaseMs ?? 60_000);
    this.heartbeatMs = Math.max(10, Math.min(this.leaseMs - 1, options.heartbeatMs ?? Math.floor(this.leaseMs / 3)));
    this.retryBaseMs = Math.max(0, options.retryBaseMs ?? 1_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 60_000);
    this.now = options.now ?? (() => new Date().toISOString());
    this.onError = options.onError;
  }

  private readonly onError?: (error: unknown) => void;

  async runOnce(): Promise<DurableTask | null> {
    const timestamp = this.now();
    this.store.recoverExpired(timestamp);
    const task = this.store.claimNext(timestamp, this.leaseMs);
    if (!task) return null;

    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      this.store.renewLease(task.taskId, this.now(), this.leaseMs);
    }, this.heartbeatMs);
    try {
      const output = await this.handler(task, controller.signal);
      const resultText = output && typeof output === "object" ? output.result : undefined;
      this.store.transition(task.taskId, "verifying", {
        now: this.now(),
        reason: "worker handler completed; verifying result",
        ...(resultText ? { result: resultText } : {}),
      });
      return this.store.transition(task.taskId, "completed", {
        now: this.now(),
        reason: "worker verification completed",
        ...(resultText ? { result: resultText } : {}),
      });
    } catch (error) {
      this.onError?.(error);
      const message = error instanceof Error ? error.message : String(error);
      if (task.attemptCount >= task.maxAttempts) {
        return this.store.transition(task.taskId, "failed", {
          now: this.now(),
          reason: `worker handler failed after ${task.attemptCount}/${task.maxAttempts} attempts`,
          error: message,
        });
      }
      const delayMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.max(0, task.attemptCount - 1)));
      const nextRetryAt = new Date(Date.parse(this.now()) + delayMs).toISOString();
      return this.store.transition(task.taskId, "retrying", {
        now: this.now(),
        reason: `worker handler failed; retry ${task.attemptCount + 1}/${task.maxAttempts} scheduled after ${delayMs}ms`,
        error: message,
        nextRetryAt,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  start(): Promise<void> {
    if (this.loopPromise) return this.loopPromise;
    this.running = true;
    this.loopPromise = (async () => {
      while (this.running) {
        try {
          await this.runOnce();
        } catch (error) {
          this.onError?.(error);
        }
        if (this.running) await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      }
    })().finally(() => {
      this.loopPromise = null;
    });
    return this.loopPromise;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
  }
}
