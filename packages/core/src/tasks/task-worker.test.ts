import Database from "better-sqlite3";
import { DurableTaskStore } from "./task-store.js";
import { calculateDurableTaskRetryDelayMs, DurableTaskWorker } from "./task-worker.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("durable task retry delay", () => {
  it("never exceeds the configured exponential cap after jitter", () => {
    expect(calculateDurableTaskRetryDelayMs(10, 3_000, 10_000, "transient", undefined, () => 1)).toBe(10_000);
  });

  it("honors Retry-After but bounds it to the global safety ceiling", () => {
    expect(calculateDurableTaskRetryDelayMs(1, 1_000, 10_000, "rate_limit", 2_500)).toBe(2_500);
    expect(calculateDurableTaskRetryDelayMs(1, 1_000, 10_000, "rate_limit", 100_000_000)).toBe(86_400_000);
  });

  it("uses the maximum configured delay for resource exhaustion", () => {
    expect(calculateDurableTaskRetryDelayMs(1, 1_000, 10_000, "resource_exhaustion", undefined, () => 0)).toBe(10_000);
  });
});

describe("DurableTaskWorker", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("restarts the poll loop after an unexpected exit and cancels recovery on stop", async () => {
    jest.useFakeTimers();
    try {
      const store = new DurableTaskStore(db);
      const worker = new DurableTaskWorker(store, async () => ({ result: "unused" }), { pollMs: 25 });
      const realRunLoop = (worker as any).runLoop.bind(worker);
      const loop = jest.spyOn(worker as any, "runLoop")
        .mockRejectedValueOnce(new Error("injected worker loop failure"))
        .mockImplementation(realRunLoop);
      const initialLoop = worker.start().catch(() => undefined);
      await jest.advanceTimersByTimeAsync(0);
      expect(worker.status()).toMatchObject({ running: true, loop_restart_pending: true, loop_restart_count: 1 });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(loop).toHaveBeenCalledTimes(2);
      await worker.stop();
      await initialLoop;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(loop).toHaveBeenCalledTimes(2);
      expect(worker.status().running).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps the durable poll loop alive after a transient store error", async () => {
    const store = new DurableTaskStore(db);
    const errors: unknown[] = [];
    const claim = jest.spyOn(store, "claimNext")
      .mockImplementationOnce(() => { throw new Error("temporary sqlite busy"); })
      .mockImplementation(() => null);
    const worker = new DurableTaskWorker(store, async () => ({ result: "unused" }), {
      pollMs: 25,
      onError: (error) => errors.push(error),
    });
    const loop = worker.start();
    await wait(100);
    expect(errors.some((error) => error instanceof Error && error.message === "temporary sqlite busy")).toBe(true);
    expect(claim.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(worker.status()).toMatchObject({ running: true, consecutive_loop_failures: 0 });
    await worker.stop();
    await loop;
    expect(worker.status().running).toBe(false);
  });

  it("claims a task, renews its lease, and completes it", async () => {
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const now = () => iso(clock);
    const store = new DurableTaskStore(db, now);
    store.create({ taskId: "worker-1", goal: "run durable work", now: now() });
    let renewedLease: string | undefined;
    const worker = new DurableTaskWorker(store, async (task) => {
      expect(task.status).toBe("running");
      clock += 1_000;
      await wait(30);
      renewedLease = store.get(task.taskId)?.leaseExpiresAt;
      return { result: "work complete" };
    }, { now, leaseMs: 2_000, heartbeatMs: 10 });

    const completed = await worker.runOnce();

    expect(renewedLease).toBe(iso(clock + 2_000));
    expect(completed).toMatchObject({ taskId: "worker-1", status: "completed", result: "work complete" });
    expect(store.listEvents("worker-1").map((event) => event.toStatus)).toEqual([
      "queued",
      "running",
      "verifying",
      "completed",
    ]);
  });

  it("requeues a failed handler with backoff and can claim it again when due", async () => {
    const errors: unknown[] = [];
    let attempt = 0;
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const now = () => iso(clock);
    const store = new DurableTaskStore(db, now);
    store.create({ taskId: "worker-2", goal: "retry durable work", now: now() });
    const worker = new DurableTaskWorker(store, async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary worker failure");
      return { result: "recovered work" };
    }, { now, retryBaseMs: 1_000, retryMaxMs: 10_000, onError: (error) => errors.push(error) });

    const retrying = await worker.runOnce();
    expect(retrying).toMatchObject({ status: "retrying", lastError: "temporary worker failure", attemptCount: 1 });
    const firstRetryAt = Date.parse(retrying!.nextRetryAt!);
    expect(firstRetryAt).toBeGreaterThanOrEqual(clock + 800);
    expect(firstRetryAt).toBeLessThanOrEqual(clock + 1_200);
    expect(await worker.runOnce()).toBeNull();
    clock += 2_000;
    const completed = await worker.runOnce();

    expect(completed).toMatchObject({ status: "completed", result: "recovered work", attemptCount: 2 });
    expect(errors).toHaveLength(1);
  });

  it("keeps a task retryable indefinitely when its persisted maximum is -1", async () => {
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const now = () => iso(clock);
    const store = new DurableTaskStore(db, now);
    store.create({ taskId: "worker-unbounded", goal: "recover eventually", maxAttempts: -1, now: now() });
    let calls = 0;
    const worker = new DurableTaskWorker(store, async () => {
      calls += 1;
      if (calls < 5) throw new Error("temporary network failure");
      return { result: "recovered" };
    }, { now, retryBaseMs: 10, retryMaxMs: 100 });
    for (let i = 0; i < 4; i += 1) {
      const retrying = await worker.runOnce();
      expect(retrying?.status).toBe("retrying");
      expect(retrying?.maxAttempts).toBe(-1);
      clock += 1_000;
    }
    const completed = await worker.runOnce();
    expect(completed).toMatchObject({ status: "completed", result: "recovered", attemptCount: 5, maxAttempts: -1 });
  });

  it("continues an active task without any inactivity deadline", async () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "unbounded-lifetime", taskType: "background_agent", goal: "continue until explicitly completed", maxAttempts: -1 });
    let release!: () => void;
    let started!: () => void;
    let observedSignal: AbortSignal | undefined;
    const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
    const worker = new DurableTaskWorker(store, async (_task, signal) => {
      observedSignal = signal;
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { result: "finished after an extended wait" };
    }, { taskType: "background_agent", leaseMs: 1_000, heartbeatMs: 20 });

    const running = worker.runOnce();
    await handlerStarted;
    await wait(60);
    expect(observedSignal?.aborted).toBe(false);
    expect(store.get("unbounded-lifetime")).toMatchObject({ status: "running", maxAttempts: -1 });
    release();
    await expect(running).resolves.toMatchObject({ status: "completed", result: "finished after an extended wait" });
  });

  it("leaves a non-cooperative shutdown lease for normal expiry recovery without a task deadline", async () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "shutdown-abandoned", taskType: "background_agent", goal: "leave lease for recovery", maxAttempts: -1 });
    const worker = new DurableTaskWorker(store, async () => new Promise(() => undefined), {
      taskType: "background_agent", leaseMs: 2_000, heartbeatMs: 100, shutdownGraceMs: 5,
    });
    const keepAlive = setInterval(() => undefined, 1_000);
    const loop = worker.start();
    await wait(0);
    await worker.stop();
    expect(store.get("shutdown-abandoned")?.status).toBe("running");
    await wait(50);
    await loop;
    clearInterval(keepAlive);
    expect(store.get("shutdown-abandoned")?.status).toBe("running");
  });

  it("does not commit a result after its lease has expired", async () => {
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const now = () => iso(clock);
    const store = new DurableTaskStore(db, now);
    store.create({ taskId: "expired-worker", taskType: "background_agent", goal: "lease must fence commit" });
    const worker = new DurableTaskWorker(store, async () => {
      clock += 1_001;
      return { result: "must not commit" };
    }, { taskType: "background_agent", now, leaseMs: 1_000, heartbeatMs: 999 });

    const observed = await worker.runOnce();
    expect(observed?.status).toBe("running");
    expect(observed?.result).toBeUndefined();
    expect(store.recoverExpired(now(), { taskType: "background_agent" })[0]).toMatchObject({ status: "retrying" });
  });

  it("stops retrying after the persisted maximum attempts", async () => {
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const now = () => iso(clock);
    const store = new DurableTaskStore(db, now);
    store.create({ taskId: "worker-cap", goal: "never-ending failure", maxAttempts: 2, now: now() });
    let calls = 0;
    const worker = new DurableTaskWorker(store, async () => {
      calls += 1;
      throw new Error("permanent logic failure");
    }, { now, retryBaseMs: 10, retryMaxMs: 100 });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ status: "retrying", attemptCount: 1, maxAttempts: 2 });
    clock += 100;
    const second = await worker.runOnce();
    expect(second).toMatchObject({ status: "failed", attemptCount: 2, maxAttempts: 2 });
    expect(await worker.runOnce()).toBeNull();
    expect(calls).toBe(2);
  });

  it("notifies when crash recovery exhausts the persisted attempts", async () => {
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const now = () => iso(clock);
    const store = new DurableTaskStore(db, now);
    store.create({ taskId: "crashed-final-attempt", taskType: "background_agent", goal: "recover and notify", maxAttempts: 1, now: now() });
    store.claimNext(now(), 1_000, { taskType: "background_agent" });
    clock += 1_001;
    const settled: string[] = [];
    const worker = new DurableTaskWorker(store, async () => undefined, {
      taskType: "background_agent",
      now,
      onSettled: (task) => settled.push(`${task.taskId}:${task.status}`),
    });

    expect(await worker.runOnce()).toBeNull();
    expect(store.get("crashed-final-attempt")?.status).toBe("failed");
    expect(settled).toEqual(["crashed-final-attempt:failed"]);
  });

  it("adapts new task admission to a changing concurrency ceiling without interrupting active work", async () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "adaptive-1", taskType: "background_agent", goal: "first" });
    store.create({ taskId: "adaptive-2", taskType: "background_agent", goal: "second" });
    let ceiling = 1;
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const worker = new DurableTaskWorker(store, async () => {
      started += 1;
      await gate;
      return { result: "done" };
    }, { taskType: "background_agent", pollMs: 10, maxConcurrency: 2, getMaxConcurrency: () => ceiling });

    const loop = worker.start();
    await wait(30);
    expect(started).toBe(1);
    ceiling = 2;
    await wait(30);
    expect(started).toBe(2);
    release();
    await wait(30);
    await worker.stop();
    await expect(loop).resolves.toBeUndefined();
    expect(store.get("adaptive-1")?.status).toBe("completed");
    expect(store.get("adaptive-2")?.status).toBe("completed");
  });

  it("backs off when the queue is empty instead of spinning the polling loop", async () => {
    const store = new DurableTaskStore(db);
    const claim = jest.spyOn(store, "claimNext");
    const worker = new DurableTaskWorker(store, async () => undefined, { pollMs: 20 });
    const loop = worker.start();
    await wait(110);
    await worker.stop();
    await loop;
    expect(claim.mock.calls.length).toBeLessThan(12);
  });

  it("stops a polling loop without leaving a background timer", async () => {
    const store = new DurableTaskStore(db);
    const worker = new DurableTaskWorker(store, async () => undefined, { pollMs: 10 });
    const loop = worker.start();
    await wait(15);
    await worker.stop();
    await expect(loop).resolves.toBeUndefined();
  });

  it("handles background jobs only and cancels a running task when requested", async () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "unrelated", taskType: "tracked_run", goal: "not for this worker" });
    store.create({ taskId: "background-cancel", taskType: "background_agent", goal: "long task" });
    const worker = new DurableTaskWorker(store, async (_task, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { result: "cancelled by request" };
    }, { taskType: "background_agent", pollMs: 10, leaseMs: 1_000, heartbeatMs: 10 });
    const running = worker.runOnce();
    await wait(20);
    expect(store.requestCancel("background-cancel")).toMatchObject({ accepted: true });
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    expect(store.get("unrelated")?.status).toBe("queued");
  });

  it("releases an active claim on graceful worker shutdown without consuming an attempt", async () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "shutdown-job", taskType: "background_agent", goal: "resume after shutdown" });
    const worker = new DurableTaskWorker(store, async (_task, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { result: "stopped" };
    }, { taskType: "background_agent", pollMs: 10, leaseMs: 1_000, heartbeatMs: 10 });
    const loop = worker.start();
    await wait(30);
    await worker.stop();
    await expect(loop).resolves.toBeUndefined();
    expect(store.get("shutdown-job")).toMatchObject({ status: "retrying", attemptCount: 0 });
  });


  it("moves a handler failure with an unsettled write action directly to reconciliation", async () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "action-uncertain", taskType: "background_agent", goal: "never blindly replay a write" });
    const worker = new DurableTaskWorker(store, async (task) => {
      expect(store.claimAction(task.taskId, "write-action", "file_write", task.leaseToken!)).toEqual({ status: "execute" });
      store.failAction(task.taskId, "write-action", "connection dropped after write request", task.leaseToken!);
      throw new Error("connection dropped");
    }, { taskType: "background_agent" });
    expect(await worker.runOnce()).toMatchObject({ status: "needs_reconciliation", errorCategory: "uncertain_side_effect" });
    expect(store.listUnsettledActions("action-uncertain")).toHaveLength(1);
  });

  it("requires a real verifier for tasks with explicit acceptance criteria", async () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "verifier-required", taskType: "background_agent", goal: "must verify", verificationSpec: { kind: "external_check" } });
    const worker = new DurableTaskWorker(store, async () => ({ result: "claimed complete" }), { taskType: "background_agent" });
    const result = await worker.runOnce();
    expect(result).toMatchObject({ status: "blocked", errorCategory: "auth_config" });
  });

  it("retries transient verifier failures and preserves verification evidence", async () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "verifier-retry", taskType: "background_agent", goal: "verify after retry", verificationSpec: { kind: "test" } });
    const worker = new DurableTaskWorker(store, async () => ({ result: "finished" }), {
      taskType: "background_agent",
      retryBaseMs: 10,
      retryMaxMs: 100,
      verifier: () => ({ passed: false, errorCategory: "transient", reason: "temporary verifier outage", evidence: { probe: "unavailable" } }),
    });
    const result = await worker.runOnce();
    expect(result).toMatchObject({ status: "retrying", errorCategory: "transient", verificationResult: { passed: false, evidence: { probe: "unavailable" } } });
  });

  it("routes uncertain verifier results to reconciliation and cancellation to cancelled", async () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "verify-uncertain", taskType: "background_agent", goal: "uncertain", verificationSpec: { kind: "test" } });
    const uncertain = new DurableTaskWorker(store, async () => ({ result: "done" }), {
      taskType: "background_agent",
      verifier: () => ({ passed: false, errorCategory: "uncertain_side_effect", reason: "external state unknown" }),
    });
    expect(await uncertain.runOnce()).toMatchObject({ status: "needs_reconciliation", errorCategory: "uncertain_side_effect" });

    store.create({ taskId: "verify-cancel", taskType: "background_agent", goal: "cancelled", verificationSpec: { kind: "test" } });
    const cancelled = new DurableTaskWorker(store, async () => ({ result: "done" }), {
      taskType: "background_agent",
      verifier: () => ({ passed: false, errorCategory: "cancelled", reason: "operator cancelled" }),
    });
    expect(await cancelled.runOnce()).toMatchObject({ status: "cancelled" });
  });

  it("pauses new claims when dynamic concurrency is zero and resumes when capacity returns", async () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "paused-queue", taskType: "background_agent", goal: "wait for capacity" });
    let ceiling = 0;
    let started = 0;
    const worker = new DurableTaskWorker(store, async () => { started += 1; return { result: "done" } }, {
      taskType: "background_agent", pollMs: 10, maxConcurrency: 1, getMaxConcurrency: () => ceiling,
    });
    const loop = worker.start();
    await wait(40);
    expect(started).toBe(0);
    expect(store.get("paused-queue")?.status).toBe("queued");
    ceiling = 1;
    await wait(40);
    await worker.stop();
    await loop;
    expect(started).toBe(1);
    expect(store.get("paused-queue")?.status).toBe("completed");
  });


  it("returns from shutdown after its grace period and leaves a non-cooperative handler for lease recovery", async () => {
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const now = () => iso(clock);
    const store = new DurableTaskStore(db, now);
    store.create({ taskId: "shutdown-timeout", taskType: "background_agent", goal: "non-cooperative" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const errors: unknown[] = [];
    const worker = new DurableTaskWorker(store, async () => {
      await gate; // Deliberately ignores AbortSignal.
      return { result: "late result" };
    }, {
      taskType: "background_agent", leaseMs: 100, heartbeatMs: 10, shutdownGraceMs: 10,
      onError: (error) => errors.push(error),
    });
    const loop = worker.start();
    await wait(20);
    await worker.stop();
    expect(store.get("shutdown-timeout")?.status).toBe("running");
    expect(errors.some((error) => String(error).includes("leases will expire"))).toBe(true);
    clock += 101;
    release();
    await wait(10);
    await loop;
    expect(store.get("shutdown-timeout")?.status).toBe("running");
    expect(store.get("shutdown-timeout")?.result).toBeUndefined();
    expect(store.recoverExpired(now(), { taskType: "background_agent" })[0]?.status).toBe("retrying");
  });

});
