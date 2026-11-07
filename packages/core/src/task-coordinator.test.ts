import Database from "better-sqlite3";
import { DurableTaskStore } from "./task-store.js";
import { UnifiedTaskCoordinator } from "./task-coordinator.js";

describe("UnifiedTaskCoordinator", () => {
  let db: Database.Database;
  let store: DurableTaskStore;
  let coordinator: UnifiedTaskCoordinator;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new DurableTaskStore(db);
    coordinator = new UnifiedTaskCoordinator(db, store);
    db.exec(`CREATE TABLE autonomy_task_queue (task_id INTEGER PRIMARY KEY, durable_task_id TEXT, status TEXT NOT NULL)`);
  });

  afterEach(() => db.close());

  it("links foreground/background execution records idempotently", () => {
    store.create({ taskId: "run-1", goal: "foreground" });
    coordinator.link("foreground_run", "run-1", "run-1");
    coordinator.link("foreground_run", "run-1", "run-1");
    expect(coordinator.snapshot().lineageLinks).toBe(1);
  });

  it("rejects a conflicting lineage mapping instead of silently retargeting it", () => {
    store.create({ taskId: "run-a", goal: "first" });
    store.create({ taskId: "run-b", goal: "second" });
    coordinator.link("foreground_run", "same-origin", "run-a");
    expect(() => coordinator.link("foreground_run", "same-origin", "run-b")).toThrow("already bound to a different durable task");
  });

  it("reconciles autonomous scheduler mappings without changing task status", () => {
    store.create({ taskId: "autonomy:10", goal: "scheduled item" });
    db.prepare("INSERT INTO autonomy_task_queue(task_id,durable_task_id,status) VALUES(?,?,?)").run(10, "autonomy:10", "running");
    const result = coordinator.reconcileAutonomySchedules();
    expect(result).toMatchObject({ linked: 1, missingDurableTasks: 0, skipped: 0 });
    expect(store.get("autonomy:10")?.status).toBe("queued");
    expect(coordinator.snapshot().unlinkedScheduledTasks).toBe(0);
  });

  it("owns scheduled execution status mirroring in the canonical durable ledger", () => {
    db.prepare("INSERT INTO autonomy_task_queue(task_id,durable_task_id,status) VALUES(?,?,?)").run(12, null, "running");
    coordinator.mirrorAutonomyScheduleExecution({ scheduleTaskId: 12, durableTaskId: "autonomy:12", title: "scheduled run", status: "running" });
    expect(store.get("autonomy:12")?.status).toBe("running");
    coordinator.mirrorAutonomyScheduleExecution({ scheduleTaskId: 12, durableTaskId: "autonomy:12", title: "scheduled run", status: "completed", result: "verified" });
    expect(store.get("autonomy:12")?.status).toBe("completed");
    expect(coordinator.snapshot().lineageLinks).toBe(1);
    expect(coordinator.snapshot().unlinkedScheduledTasks).toBe(0);
  });

  it("reports missing durable tasks without deleting scheduler references", () => {
    db.prepare("INSERT INTO autonomy_task_queue(task_id,durable_task_id,status) VALUES(?,?,?)").run(11, "missing-task", "running");
    expect(coordinator.reconcileAutonomySchedules()).toMatchObject({ linked: 0, missingDurableTasks: 1 });
    expect(coordinator.snapshot().missingDurableTasks).toBe(0);
    expect(coordinator.snapshot().unlinkedScheduledTasks).toBe(1);
  });
});
