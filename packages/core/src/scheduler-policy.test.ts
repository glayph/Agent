import Database from "better-sqlite3";
import { describe, expect, it } from "@jest/globals";
import { SqliteScheduledTaskStore } from "./scheduled-task-store.js";
import { TaskScheduler, parseCronToNextRun } from "./scheduler.js";
import { TaskQueue } from "./task-queue.js";
import { ConcurrentTaskManager } from "./concurrent-manager.js";

describe("durable scheduler policies", () => {
  it("persists interval, timezone, retry, timeout, and quiet-hour policy", () => {
    const db = new Database(":memory:");
    const store = new SqliteScheduledTaskStore(db);
    const scheduler = new TaskScheduler(
      { schedulerIntervalMs: 20, timezone: "Asia/Dhaka", retryBaseDelayMs: 10 },
      new TaskQueue({ maxSize: 5 }),
      new ConcurrentTaskManager(1),
      async function* () { yield "ok"; },
      store,
    );
    const task = scheduler.schedule("miki-main-chat", "heartbeat task", undefined, Date.now(), {
      intervalMs: 60_000,
      timezone: "Asia/Dhaka",
      missedRunPolicy: "skip",
      timeoutMs: 5_000,
      quietHours: { start: "22:00", end: "07:00", timezone: "Asia/Dhaka" },
      concurrencyLimit: 1,
      maxAttempts: 2,
    });
    const restored = store.loadTask(task.id)!;
    expect(restored.intervalMs).toBe(60_000);
    expect(restored.timezone).toBe("Asia/Dhaka");
    expect(restored.missedRunPolicy).toBe("skip");
    expect(restored.timeoutMs).toBe(5_000);
    expect(restored.quietHours?.start).toBe("22:00");
    expect(restored.concurrencyLimit).toBe(1);
    scheduler.start();
    expect(scheduler.getHealthMetrics().running).toBe(true);
    scheduler.heartbeat();
    expect(scheduler.getHealthMetrics().healthy).toBe(true);
    scheduler.stop();
    db.close();
  });

  it("supports timezone-aware standard cron fields", () => {
    const next = parseCronToNextRun("0 9 * * *", Date.parse("2026-01-01T00:00:00.000Z"), "Asia/Dhaka");
    expect(next).toBe(Date.parse("2026-01-01T03:00:00.000Z"));
  });

  it("emits one completion notification with retry and duration metadata", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const scheduler = new TaskScheduler(
      { schedulerIntervalMs: 10 },
      new TaskQueue({ maxSize: 5 }),
      new ConcurrentTaskManager(1),
      async function* () { yield "concise result"; },
      undefined,
      (notification) => { notifications.push(notification as unknown as Record<string, unknown>); },
    );
    const task = scheduler.schedule("miki-main-chat", "Generate report", undefined, Date.now(), { maxAttempts: 1 });
    scheduler.start();
    for (let i = 0; i < 30 && task.status !== "completed"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    scheduler.stop();
    expect(task.status).toBe("completed");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("Generate report");
    expect(notifications[0].retryCommand).toBe(`/retry ${task.id}`);
    expect(notifications[0].durationMs).toEqual(expect.any(Number));
  });
});
