import Database from "better-sqlite3";
import { DurableTaskStore } from "./task-store.js";

describe("DurableTaskStore", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("persists a queued task and its creation event", () => {
    const store = new DurableTaskStore(db, () => "2026-10-15T00:00:00.000Z");
    const created = store.create({ taskId: "task-1", goal: "inspect workspace", sessionId: "session-1" });

    expect(created).toMatchObject({
      taskId: "task-1",
      goal: "inspect workspace",
      sessionId: "session-1",
      status: "queued",
      version: 0,
      createdAt: "2026-10-15T00:00:00.000Z",
    });
    expect(store.listEvents("task-1")).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: "queued", version: 0, reason: "task created" }),
    ]);
  });

  it("records transactional transitions with monotonic versions", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "task-2", goal: "run checks", now: "2026-10-15T00:00:00.000Z" });

    const running = store.transition("task-2", "running", {
      now: "2026-10-15T00:00:01.000Z",
      leaseMs: 1_000,
      reason: "worker claimed task",
    });
    const verifying = store.transition("task-2", "verifying", {
      now: "2026-10-15T00:00:02.000Z",
      reason: "execution finished",
    });
    const completed = store.transition("task-2", "completed", {
      now: "2026-10-15T00:00:03.000Z",
      reason: "verification passed",
    });

    expect(running).toMatchObject({ status: "running", version: 1, leaseExpiresAt: "2026-10-15T00:00:02.000Z" });
    expect(verifying).toMatchObject({ status: "verifying", version: 2 });
    expect(completed).toMatchObject({ status: "completed", version: 3 });
    expect(store.listEvents("task-2").map((event) => [event.fromStatus, event.toStatus, event.version])).toEqual([
      [null, "queued", 0],
      ["queued", "running", 1],
      ["running", "verifying", 2],
      ["verifying", "completed", 3],
    ]);
  });

  it("reloads persisted tasks and requeues an expired worker lease", () => {
    const first = new DurableTaskStore(db);
    first.create({ taskId: "task-3", goal: "recover me", now: "2026-10-15T00:00:00.000Z" });
    first.claimNext("2026-10-15T00:00:01.000Z", 1_000);

    const restarted = new DurableTaskStore(db);
    expect(restarted.get("task-3")).toMatchObject({ status: "running", version: 1 });
    expect(restarted.recoverExpired("2026-10-15T00:00:03.000Z")).toMatchObject([
      { taskId: "task-3", status: "retrying", version: 2 },
    ]);
    expect(restarted.listEvents("task-3").at(-1)).toMatchObject({
      fromStatus: "running",
      toStatus: "retrying",
      reason: "worker lease expired; task requeued",
    });
    expect(restarted.claimNext("2026-10-15T00:00:04.000Z", 5_000)).toMatchObject({
      status: "running",
      version: 3,
    });
  });

  it("rejects invalid transitions without writing an event", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "task-4", goal: "do not skip" });

    expect(() => store.transition("task-4", "completed")).toThrow(/Invalid task state transition/);
    expect(store.get("task-4")?.status).toBe("queued");
    expect(store.listEvents("task-4")).toHaveLength(1);
  });

  it("persists terminal output and failure details", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "task-5", goal: "persist output", now: "2026-10-15T00:00:00.000Z" });
    store.transition("task-5", "running", { now: "2026-10-15T00:00:01.000Z" });
    store.transition("task-5", "verifying", { now: "2026-10-15T00:00:02.000Z" });
    store.transition("task-5", "completed", {
      now: "2026-10-15T00:00:03.000Z",
      result: "verified output",
    });
    expect(store.get("task-5")).toMatchObject({ status: "completed", result: "verified output" });

    store.create({ taskId: "task-6", goal: "persist error", now: "2026-10-15T00:00:00.000Z" });
    store.transition("task-6", "running", { now: "2026-10-15T00:00:01.000Z" });
    store.transition("task-6", "failed", {
      now: "2026-10-15T00:00:02.000Z",
      reason: "execution failed",
      error: "provider unavailable",
    });
    expect(store.get("task-6")).toMatchObject({ status: "failed", lastError: "provider unavailable" });
  });
});
