import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersistentJobQueue } from "./persistent-job-queue.js";
import { PersistentTimerScheduler } from "./timer-scheduler.js";

describe("PersistentTimerScheduler", () => {
  it("persists timers and enqueues due agent jobs idempotently", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-timers-"));
    const timerFile = path.join(dir, "timers.json");
    const jobFile = path.join(dir, "jobs.json");
    const jobs = new PersistentJobQueue(jobFile);
    const scheduler = new PersistentTimerScheduler(timerFile, jobs);
    const timer = scheduler.create({
      sessionId: "session-1",
      message: "run timer task",
      schedule: "every 1 seconds",
    });
    expect(scheduler.list()).toHaveLength(1);
    const timerData = JSON.parse(fs.readFileSync(timerFile, "utf8")) as {
      timers: unknown[];
    };
    expect(timerData.timers).toHaveLength(1);

    const due = scheduler as unknown as { tick: () => void };
    const stored = scheduler.list()[0];
    if (stored) stored.nextRunAt = Date.now() - 1;
    due.tick();
    expect(jobs.list()).toHaveLength(1);
    expect(jobs.list()[0]?.idempotencyKey).toBe(
      `timer:${timer.id}:${stored?.lastEnqueuedAt ? stored.nextRunAt - 1000 : ""}`,
    );
    expect(scheduler.list()[0]?.nextRunAt).toBeGreaterThan(Date.now());

    const recovered = new PersistentTimerScheduler(timerFile, jobs);
    expect(recovered.list()[0]?.id).toBe(timer.id);
    scheduler.stop();
    recovered.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects unsupported timer expressions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-timers-invalid-"));
    const scheduler = new PersistentTimerScheduler(
      path.join(dir, "timers.json"),
      new PersistentJobQueue(path.join(dir, "jobs.json")),
    );
    expect(() =>
      scheduler.create({ sessionId: "s", message: "m", schedule: "never" }),
    ).toThrow("Unsupported schedule expression");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
