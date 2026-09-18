import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import Database from "better-sqlite3";
import {
  createAutonomyController,
  type AutonomyController,
  type ScheduledTaskLike,
} from "./autonomy-controller.js";
import { DEFAULT_AUTONOMY_CONFIG } from "./config.js";
import type { AutonomyMode } from "./types.js";

/** A tiny fake standing in for TaskScheduler: schedule() creates a
 * "pending" entry; the test flips its status to simulate the real
 * scheduler/agent loop finishing the work. */
function makeFakeScheduler() {
  const tasks = new Map<string, ScheduledTaskLike>();
  let counter = 0;
  return {
    tasks,
    schedule: (_sessionId: string, _message: string) => {
      const id = `task-${++counter}`;
      tasks.set(id, { id, status: "pending" });
      return { id };
    },
    getScheduledTask: (id: string) => tasks.get(id),
    setStatus: (
      id: string,
      status: ScheduledTaskLike["status"],
      lastError?: string,
    ) => {
      tasks.set(id, { id, status, lastError });
    },
  };
}

function makeController(opts: {
  db: Database.Database;
  scheduler: ReturnType<typeof makeFakeScheduler>;
  mode?: AutonomyMode;
  hints?: Record<string, unknown>;
  providerHealthy?: () => boolean;
  activeTasks?: number;
  maxConcurrent?: number;
}): AutonomyController {
  return createAutonomyController({
    db: opts.db,
    schedule: opts.scheduler.schedule,
    getScheduledTask: opts.scheduler.getScheduledTask,
    concurrentManager: {
      activeCount: opts.activeTasks ?? 0,
      maxConcurrent: opts.maxConcurrent ?? 3,
    },
    isProviderHealthy: opts.providerHealthy ?? (() => true),
    hints: () => opts.hints ?? {},
    config: { ...DEFAULT_AUTONOMY_CONFIG, mode: opts.mode ?? "turbo" },
  });
}

describe("AutonomyController — idle gating", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  it("does nothing while the user is still active (idleMins below threshold)", async () => {
    const scheduler = makeFakeScheduler();
    const controller = makeController({
      db,
      scheduler,
      mode: "turbo", // idleThresholdMins = 1
      hints: { failingTests: ["a.test.ts"] },
    });
    await controller.tick(0.2, { free_mem_pct: 50, cpus: 4 });
    expect(scheduler.tasks.size).toBe(0);
    expect(controller.getStatus().currentObjective).toBeNull();
  });

  it("respects turbo's planningEveryNPulses (fires on every pulse)", async () => {
    const scheduler = makeFakeScheduler();
    const controller = makeController({
      db,
      scheduler,
      mode: "turbo", // planningEveryNPulses = 1, idleThresholdMins = 1
      hints: { failingTests: ["a.test.ts"] },
    });
    await controller.tick(10, { free_mem_pct: 50, cpus: 4 }); // pulse 1 → fires immediately
    expect(scheduler.tasks.size).toBe(1);
  });
});

describe("AutonomyController — end-to-end autonomous cycle (spec §21)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  it("generates, executes, records, and then selects the next objective — never simply stopping", async () => {
    const scheduler = makeFakeScheduler();
    const hints: Record<string, unknown> = { failingTests: ["a.test.ts"] };
    const controller = makeController({ db, scheduler, mode: "turbo", hints });

    // 1. No user task, idle: an autonomous objective is generated & dispatched.
    await controller.tick(10, { free_mem_pct: 60, cpus: 4 });
    let status = controller.getStatus();
    expect(status.state).toBe("EXECUTING");
    expect(status.currentObjective?.type).toBe("TESTING");
    const firstTaskId = status.currentObjective?.activeTaskId!;
    expect(firstTaskId).toBeDefined();

    // 2. Still running — ticking again must not schedule a second task.
    await controller.tick(10, { free_mem_pct: 60, cpus: 4 });
    expect(scheduler.tasks.size).toBe(1);

    // 3. The (fake) scheduler finishes the task successfully.
    scheduler.setStatus(firstTaskId, "completed");
    hints.failingTests = []; // that problem is gone now
    hints.recentErrors = ["NullPointerException in foo.ts"]; // a different signal appears

    // 4. Next tick observes completion, records it, and immediately selects
    //    a *different* objective rather than going idle forever.
    await controller.tick(10, { free_mem_pct: 60, cpus: 4 });
    status = controller.getStatus();
    expect(status.tasksCompleted).toBe(1);
    expect(status.currentObjective?.type).toBe("BUG_INVESTIGATION");
    expect(status.state).toBe("EXECUTING");
    expect(scheduler.tasks.size).toBe(2);

    const history = controller.getHistory(10);
    const firstObjective = history.find((o) => o.type === "TESTING");
    expect(firstObjective?.status).toBe("completed");
  });

  it("replans on failure rather than treating the objective as permanently done", async () => {
    const scheduler = makeFakeScheduler();
    const controller = makeController({
      db,
      scheduler,
      mode: "turbo",
      hints: { failingTests: ["a.test.ts"] },
    });
    await controller.tick(10, { free_mem_pct: 60, cpus: 4 });
    const taskId = controller.getStatus().currentObjective?.activeTaskId!;
    scheduler.setStatus(taskId, "failed", "still red");
    await controller.tick(10, { free_mem_pct: 60, cpus: 4 });
    const status = controller.getStatus();
    expect(status.tasksFailed).toBe(1);
    // The failure is recorded as a replan (not a terminal "failed"/"blocked"
    // state) — and because the underlying signal (failingTests) is still
    // present and idle time is still high, the *same* tick immediately
    // resumes it as a fresh UNFINISHED_WORK/TESTING attempt rather than
    // leaving it to rot. That continuity is the point of §12/§13 (observe →
    // evaluate → retry) rather than stopping after one failure.
    const history = controller.getHistory(10);
    const retried = history.find((o) => o.replans > 0);
    expect(retried?.replans).toBe(1);
    expect(retried?.status).not.toBe("failed");
    expect(retried?.status).not.toBe("blocked");
    expect(controller.getStatus().currentObjective?.id).toBe(retried?.id);
  });
});

describe("AutonomyController — user interruption (spec §9)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  it("suspends new objective selection while the user is active, then resumes", async () => {
    const scheduler = makeFakeScheduler();
    const hints: Record<string, unknown> = { failingTests: ["a.test.ts"] };
    const controller = makeController({ db, scheduler, mode: "turbo", hints });

    controller.markUserInteraction();
    expect(controller.getStatus().state).toBe("USER_TASK");

    // User is still typing — idleMins stays low.
    await controller.tick(0.1, { free_mem_pct: 60, cpus: 4 });
    expect(scheduler.tasks.size).toBe(0);
    expect(controller.getStatus().state).toBe("USER_TASK");

    // User goes quiet again past the threshold — autonomy resumes on its own.
    await controller.tick(5, { free_mem_pct: 60, cpus: 4 });
    expect(controller.getStatus().state).toBe("EXECUTING");
    expect(scheduler.tasks.size).toBe(1);
  });
});

describe("AutonomyController — restart / unfinished-objective recovery (spec §10)", () => {
  it("resumes an in-progress objective whose task the (new) scheduler no longer knows about", async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `autonomy-test-${crypto.randomUUID()}.db`,
    );
    try {
      const db1 = new Database(dbPath);
      const scheduler1 = makeFakeScheduler();
      const hints: Record<string, unknown> = { failingTests: ["a.test.ts"] };
      const controller1 = makeController({
        db: db1,
        scheduler: scheduler1,
        mode: "turbo",
        hints,
      });
      await controller1.tick(10, { free_mem_pct: 60, cpus: 4 });
      const objectiveId = controller1.getStatus().currentObjective?.id;
      expect(objectiveId).toBeDefined();
      db1.close(); // simulate the process exiting mid-flight

      // "Restart": fresh db connection to the same file, fresh (empty)
      // scheduler with no memory of the old task id.
      const db2 = new Database(dbPath);
      const scheduler2 = makeFakeScheduler();
      const controller2 = makeController({
        db: db2,
        scheduler: scheduler2,
        mode: "turbo",
        hints: {},
      });
      const resumed = controller2.getObjective(objectiveId!);
      expect(resumed?.status).toBe("pending"); // reset from in_progress, not lost
      expect(resumed?.activeTaskId).toBeUndefined();
      db2.close();
    } finally {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    }
  });
});

describe("AutonomyController — mode switching & chat commands", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  it("boots directly into turbo — no standard mode to switch out of", async () => {
    const scheduler = makeFakeScheduler();
    const controller = makeController({
      db,
      scheduler,
      hints: { failingTests: ["a.test.ts"] },
    });
    expect(controller.getMode()).toBe("turbo");
    // idleMins=2 clears turbo's threshold (1) immediately — no waiting on a
    // "standard" idle threshold that no longer exists.
    await controller.tick(2, { free_mem_pct: 60, cpus: 4 });
    expect(scheduler.tasks.size).toBe(1);
  });

  it("a 'use standard mode' chat command is not recognized and leaves turbo active", () => {
    const scheduler = makeFakeScheduler();
    const controller = makeController({ db, scheduler });
    expect(
      controller.handleChatCommand("miki use the standard mode"),
    ).toBeNull();
    expect(controller.getMode()).toBe("turbo");
  });

  it("lets ordinary chat control mode/enable/pause without a UI", () => {
    const scheduler = makeFakeScheduler();
    const controller = makeController({ db, scheduler });
    expect(controller.handleChatCommand("hey miki use the turbo mode")).toMatch(
      /TURBO/,
    );
    expect(controller.getMode()).toBe("turbo");
    expect(controller.handleChatCommand("pause autonomy")).toMatch(/paused/);
    expect(
      controller.handleChatCommand("this is just a normal question"),
    ).toBeNull();
  });
});

describe("AutonomyController — resource awareness (spec §15)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  it("throttles when already at the concurrency ceiling", async () => {
    const scheduler = makeFakeScheduler();
    const controller = makeController({
      db,
      scheduler,
      mode: "turbo",
      hints: { failingTests: ["a.test.ts"] },
      activeTasks: 10,
      maxConcurrent: 3,
    });
    await controller.tick(10, { free_mem_pct: 60, cpus: 4 });
    expect(scheduler.tasks.size).toBe(0);
  });

  it("does nothing at all when disabled", async () => {
    const scheduler = makeFakeScheduler();
    const controller = createAutonomyController({
      db,
      schedule: scheduler.schedule,
      getScheduledTask: scheduler.getScheduledTask,
      concurrentManager: { activeCount: 0, maxConcurrent: 3 },
      isProviderHealthy: () => true,
      hints: () => ({ failingTests: ["a.test.ts"] }),
      config: { ...DEFAULT_AUTONOMY_CONFIG, mode: "turbo", enabled: false },
    });
    await controller.tick(10, { free_mem_pct: 60, cpus: 4 });
    expect(scheduler.tasks.size).toBe(0);
  });
});
