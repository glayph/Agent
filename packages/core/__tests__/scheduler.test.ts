/**
 * Regression tests for TaskScheduler's execTimeoutMinutes handling (#52).
 *
 * The dashboard exposes `tools.cron.exec_timeout_minutes` and it is loaded
 * into SchedulerConfig.execTimeoutMinutes by packages/core/src/agent.ts
 * (protected file, not modified here). These tests exercise TaskScheduler
 * in isolation to confirm the timeout actually bounds a scheduled run:
 * a task whose executor never resolves must still be marked timed-out
 * (and not left "running" forever) once execTimeoutMinutes elapses.
 */

import { TaskScheduler } from "../src/scheduler.js";
import { TaskQueue } from "../src/task-queue.js";
import { ConcurrentTaskManager } from "../src/concurrent-manager.js";

function waitFor(
  check: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor: condition not met before timeout"));
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

describe("TaskScheduler exec_timeout_minutes (#52)", () => {
  it("times out a scheduled task whose executor never resolves", async () => {
    // A hanging executor: yields nothing and never settles on its own,
    // simulating an agent loop that hangs or runs indefinitely.
    async function* hangingExecutor(): AsyncGenerator<string, void, unknown> {
      await new Promise<void>(() => {
        // never resolves
      });
    }

    const scheduler = new TaskScheduler(
      {
        maxConcurrentTasks: 3,
        schedulerIntervalMs: 10,
        // 0.001 minutes = 60ms, fast enough for a real-timer test while
        // still exercising the real minutes -> ms conversion path.
        execTimeoutMinutes: 0.001,
      },
      new TaskQueue({ maxSize: 10 }),
      new ConcurrentTaskManager(3),
      hangingExecutor,
    );

    // maxAttempts: 1 so the first timeout goes straight to a terminal
    // "dead_letter" state instead of being requeued for retry, keeping
    // the assertion deterministic.
    const scheduled = scheduler.schedule(
      "session-1",
      "do something that hangs",
      undefined,
      Date.now(),
      { maxAttempts: 1 },
    );

    scheduler.start();
    try {
      await waitFor(() => scheduled.status === "dead_letter");
      expect(scheduled.status).toBe("dead_letter");
      expect(scheduled.lastError).toMatch(/timed out after 0\.001 minutes/i);
    } finally {
      scheduler.stop();
    }
  });

  it("does not time out a scheduled task that completes within the limit", async () => {
    async function* fastExecutor(): AsyncGenerator<string, void, unknown> {
      yield "ok";
    }

    const scheduler = new TaskScheduler(
      {
        maxConcurrentTasks: 3,
        schedulerIntervalMs: 10,
        execTimeoutMinutes: 5,
      },
      new TaskQueue({ maxSize: 10 }),
      new ConcurrentTaskManager(3),
      fastExecutor,
    );

    const scheduled = scheduler.schedule(
      "session-2",
      "quick task",
      undefined,
      Date.now(),
    );

    scheduler.start();
    try {
      await waitFor(() => scheduled.status === "completed");
      expect(scheduled.status).toBe("completed");
      expect(scheduled.lastError).toBeNull();
    } finally {
      scheduler.stop();
    }
  });

  it("leaves execution unbounded when exec_timeout_minutes is not configured", async () => {
    async function* fastExecutor(): AsyncGenerator<string, void, unknown> {
      yield "ok";
    }

    // No execTimeoutMinutes set at all — mirrors a workspace that has
    // never saved the cron timeout field.
    const scheduler = new TaskScheduler(
      { maxConcurrentTasks: 3, schedulerIntervalMs: 10 },
      new TaskQueue({ maxSize: 10 }),
      new ConcurrentTaskManager(3),
      fastExecutor,
    );

    const scheduled = scheduler.schedule(
      "session-3",
      "quick task, no timeout configured",
      undefined,
      Date.now(),
    );

    scheduler.start();
    try {
      await waitFor(() => scheduled.status === "completed");
      expect(scheduled.status).toBe("completed");
    } finally {
      scheduler.stop();
    }
  });
});
