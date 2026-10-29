import Database from "better-sqlite3";
import { DurableTaskStore } from "./task-store.js";
import { DurableTaskWorker } from "./task-worker.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("DurableTaskWorker", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
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
    expect(retrying).toMatchObject({ status: "retrying", lastError: "temporary worker failure", attemptCount: 1, nextRetryAt: iso(clock + 1_000) });
    expect(await worker.runOnce()).toBeNull();
    clock += 1_000;
    const completed = await worker.runOnce();

    expect(completed).toMatchObject({ status: "completed", result: "recovered work", attemptCount: 2 });
    expect(errors).toHaveLength(1);
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
    clock += 10;
    const second = await worker.runOnce();
    expect(second).toMatchObject({ status: "failed", attemptCount: 2, maxAttempts: 2 });
    expect(await worker.runOnce()).toBeNull();
    expect(calls).toBe(2);
  });

  it("stops a polling loop without leaving a background timer", async () => {
    const store = new DurableTaskStore(db);
    const worker = new DurableTaskWorker(store, async () => undefined, { pollMs: 10 });
    const loop = worker.start();
    await wait(15);
    await worker.stop();
    await expect(loop).resolves.toBeUndefined();
  });
});
