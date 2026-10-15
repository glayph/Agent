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

  it("requeues a failed handler and can claim it again after recovery", async () => {
    const errors: unknown[] = [];
    let attempt = 0;
    const store = new DurableTaskStore(db, () => "2026-10-15T00:00:00.000Z");
    store.create({ taskId: "worker-2", goal: "retry durable work", now: "2026-10-15T00:00:00.000Z" });
    const worker = new DurableTaskWorker(store, async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary worker failure");
      return { result: "recovered work" };
    }, { now: () => "2026-10-15T00:00:01.000Z", onError: (error) => errors.push(error) });

    const retrying = await worker.runOnce();
    const completed = await worker.runOnce();

    expect(retrying).toMatchObject({ status: "retrying", lastError: "temporary worker failure" });
    expect(completed).toMatchObject({ status: "completed", result: "recovered work" });
    expect(errors).toHaveLength(1);
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
