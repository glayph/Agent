import { ConcurrentTaskManager } from "./concurrent-manager.js";
import { TaskQueue } from "./task-queue.js";
import { CostCalibrator } from "./cost-calibrator.js";
import { parseCronToNextRun, TaskScheduler } from "./scheduler.js";
import { SqliteScheduledTaskStore } from "./scheduled-task-store.js";
import { buildLiteLLMConfig } from "./litellm-config.js";
import Database from "better-sqlite3";
import { resolveLiteLLMMasterKey } from "@hiro/config/security";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("ConcurrentTaskManager", () => {
  it("should start with zero active tasks", () => {
    const manager = new ConcurrentTaskManager(3);
    expect(manager.activeCount).toBe(0);
    expect(manager.maxConcurrent).toBe(3);
  });

  it("should acquire and release correctly", async () => {
    const manager = new ConcurrentTaskManager(2);

    const release1 = await manager.acquire();
    expect(manager.activeCount).toBe(1);

    const release2 = await manager.acquire();
    expect(manager.activeCount).toBe(2);
    expect(manager.isAtCapacity()).toBe(true);

    release1();
    expect(manager.activeCount).toBe(1);

    release2();
    expect(manager.activeCount).toBe(0);
  });

  it("should queue waiters when at capacity", async () => {
    const manager = new ConcurrentTaskManager(1);

    const release1 = await manager.acquire();
    expect(manager.activeCount).toBe(1);
    expect(manager.isAtCapacity()).toBe(true);

    const release2Promise = manager.acquire();
    expect(manager.waitingCount).toBe(1);

    // Release should fulfill the waiting task
    release1();
    await release2Promise;
    expect(manager.activeCount).toBe(1);
    expect(manager.waitingCount).toBe(0);
  });

  it("should not oversubscribe when multiple released quickly", async () => {
    const manager = new ConcurrentTaskManager(2);

    // Fill capacity
    const r1 = await manager.acquire();
    const r2 = await manager.acquire();
    expect(manager.activeCount).toBe(2);

    // Queue a waiter
    const r3Promise = manager.acquire();
    expect(manager.waitingCount).toBe(1);

    // Release both - should fill to capacity (1 task)
    r1();
    r2();

    await r3Promise;
    expect(manager.activeCount).toBe(1);
    expect(manager.waitingCount).toBe(0);
  });

  it("should only fulfill waiters when increasing limit", async () => {
    const manager = new ConcurrentTaskManager(2);

    // Fill capacity
    const r1 = await manager.acquire();
    const r2 = await manager.acquire();

    // Queue a waiter
    const r3Promise = manager.acquire();
    expect(manager.waitingCount).toBe(1);

    // Lowering limit should not trigger new tasks
    manager.setMaxConcurrent(1);

    // Release one - waiter should NOT be fulfilled (limit is 1 but we'd still have 2)
    r1();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The waiting task should still be waiting because we lowered the limit
    expect(manager.waitingCount).toBe(1);

    // Clean up
    r2();
    await r3Promise;
  });
});

describe("TaskQueue", () => {
  it("should enqueue and dequeue tasks", () => {
    const queue = new TaskQueue({ maxSize: 10 });

    const task = queue.enqueue("session-1", "test message", 5);
    expect(task).not.toBeNull();
    expect(task?.sessionId).toBe("session-1");
    expect(task?.status).toBe("pending");

    const stats = queue.getStats();
    expect(stats.pending).toBe(1);
  });

  it("should dequeue tasks and mark as running", () => {
    const queue = new TaskQueue({ maxSize: 10 });

    const task = queue.enqueue("session-1", "test message", 5);
    expect(task).not.toBeNull();

    const dequeued = queue.dequeue();
    expect(dequeued).not.toBeNull();
    expect(dequeued?.status).toBe("running");

    const stats = queue.getStats();
    expect(stats.pending).toBe(0);
    expect(stats.running).toBe(1);
  });

  it("should reject when at max capacity", () => {
    const queue = new TaskQueue({ maxSize: 2 });

    queue.enqueue("s1", "m1");
    queue.enqueue("s2", "m2");

    const task = queue.enqueue("s3", "m3");
    expect(task).toBeNull();
  });

  it("should apply priority aging", () => {
    const queue = new TaskQueue({
      maxSize: 10,
      enableAging: true,
      agingFactorMs: 100,
    });

    const task1 = queue.enqueue("s1", "old task", 0);
    // Simulate time passing by modifying createdAt (for testing)
    task1!.createdAt = Date.now() - 5000; // 5 seconds ago

    queue.enqueue("s2", "new task", 10);

    // Old task should now have higher effective priority
    const pending = queue.getPendingTasks();
    expect(pending[0].id).toBe(task1!.id);
  });

  it("should mark tasks complete successfully", () => {
    const queue = new TaskQueue({ maxSize: 10 });

    const task = queue.enqueue("s1", "test");
    queue.markRunning(task!.id);
    queue.complete(task!.id, "checkpoint-123");

    const completed = queue.getCompletedTasks();
    expect(completed.length).toBe(1);
    expect(completed[0].checkpointId).toBe("checkpoint-123");
  });

  it("should keep pending heap indexes consistent after dequeue and cancel", () => {
    const queue = new TaskQueue({ maxSize: 10, enableAging: false });

    const first = queue.enqueue("s1", "first", 10)!;
    const second = queue.enqueue("s1", "second", 9)!;
    const third = queue.enqueue("s1", "third", 8)!;

    expect(queue.dequeue()?.id).toBe(first.id);
    queue.cancel(third.id);

    expect(queue.getTask(third.id)?.status).toBe("cancelled");
    expect(queue.getTask(second.id)?.status).toBe("pending");
    expect(queue.dequeue()?.id).toBe(second.id);
  });
});

describe("CostCalibrator", () => {
  it("should calculate effective budget for different models", () => {
    // GPT-4o is the reference model
    const budget = CostCalibrator.effectiveBudget(1000, "openai/gpt-4o");
    expect(budget).toBe(1000);

    // GPT-4o-mini is cheaper, should get multiplier
    const miniBudget = CostCalibrator.effectiveBudget(
      1000,
      "openai/gpt-4o-mini",
    );
    expect(miniBudget).toBeGreaterThan(1000);
  });

  it("should convert usage to budget tokens", () => {
    // Using reference model - should return exact sum adjusted by cost ratio
    const budgetTokens = CostCalibrator.costInBudgetTokens(
      "openai/gpt-4o",
      100, // prompt tokens
      50, // completion tokens
    );
    expect(budgetTokens).toBe(120);

    // More expensive model (o1) should have HIGHER budget consumption
    const o1Tokens = CostCalibrator.costInBudgetTokens("openai/o1", 100, 50);
    expect(o1Tokens).toBeGreaterThan(120);
  });

  it("should handle unknown models gracefully", () => {
    const budget = CostCalibrator.effectiveBudget(1000, "unknown/model");
    expect(budget).toBe(1000); // Returns nominal for unknown

    const budgetTokens = CostCalibrator.costInBudgetTokens(
      "unknown/model",
      100,
      50,
    );
    expect(budgetTokens).toBe(150); // Returns sum for unknown
  });
});

describe("Scheduler", () => {
  it("should parse @hourly cron expression", () => {
    const next = parseCronToNextRun("@hourly");
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThan(Date.now() + 61 * 60 * 1000); // Within 61 minutes
  });

  it("should parse @daily cron expression", () => {
    const next = parseCronToNextRun("@daily");
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000); // Within 25 hours
  });

  it("should parse every N minutes expression", () => {
    const next = parseCronToNextRun("every 30 minutes");
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThan(Date.now() + 31 * 60 * 1000); // Within 31 minutes
  });

  it("should parse every N seconds expression", () => {
    const next = parseCronToNextRun("every 45 seconds");
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThan(Date.now() + 46 * 1000); // Within 46 seconds
  });

  it("should return null for unparseable cron expression", () => {
    const next = parseCronToNextRun("invalid-cron");
    expect(next).toBeNull();
    expect(parseCronToNextRun("every 0 seconds")).toBeNull();
    expect(parseCronToNextRun("every 0 minutes")).toBeNull();
  });

  it("should reject unsupported recurring schedules", () => {
    const scheduler = new TaskScheduler({
      maxConcurrentTasks: 1,
      taskQueueSize: 10,
    });

    expect(() =>
      scheduler.schedule("session-1", "bad cron", "every 0 seconds"),
    ).toThrow("Unsupported schedule expression");
    expect(() =>
      scheduler.schedule("session-1", "bad cron", "invalid-cron"),
    ).toThrow("Unsupported schedule expression");
    expect(() =>
      scheduler.schedule("session-1", "bad cron", "invalid-cron", Date.now()),
    ).toThrow("Unsupported schedule expression");
  });

  it("should validate one-shot scheduled task input", () => {
    const scheduler = new TaskScheduler({
      maxConcurrentTasks: 1,
      taskQueueSize: 10,
    });

    expect(() => scheduler.schedule("", "message")).toThrow(
      "sessionId is required",
    );
    expect(() => scheduler.schedule("session-1", " ")).toThrow(
      "message is required",
    );
    expect(() =>
      scheduler.schedule("session-1", "message", undefined, Number.NaN),
    ).toThrow("runAt must be a non-negative safe integer timestamp");
    expect(() =>
      scheduler.schedule("session-1", "message", undefined, -1),
    ).toThrow("runAt must be a non-negative safe integer timestamp");
    expect(() =>
      scheduler.schedule("session-1", "message", undefined, Date.now(), {
        maxAttempts: 0,
      }),
    ).toThrow("maxAttempts must be a positive safe integer");

    const immediate = scheduler.schedule("session-1", "message", "   ");
    expect(immediate.cronExpression).toBeUndefined();
    expect(immediate.runAt).toBeGreaterThan(0);
  });

  it("should process queued tasks through the configured executor", async () => {
    const queue = new TaskQueue({ maxSize: 10 });
    const manager = new ConcurrentTaskManager(1);
    const processed: string[] = [];
    let active = 0;
    let maxActive = 0;

    const scheduler = new TaskScheduler(
      { maxConcurrentTasks: 1, taskQueueSize: 10, schedulerIntervalMs: 5 },
      queue,
      manager,
      async function* (_sessionId, message, task) {
        const release = await manager.acquire();
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          processed.push(message);
          if (task) queue.complete(task.id);
          yield JSON.stringify({ type: "done" });
        } finally {
          active--;
          release();
        }
      },
    );

    queue.enqueue("session-1", "first");
    queue.enqueue("session-1", "second");
    scheduler.start();

    try {
      await waitFor(() => processed.length === 2);
      expect(new Set(processed)).toEqual(new Set(["first", "second"]));
      expect(maxActive).toBe(1);
      expect(queue.getStats().completed).toBe(2);
      expect(scheduler.getStats().dequeued).toBe(2);
    } finally {
      scheduler.stop();
    }
  });

  it("should complete queued tasks when the executor finishes", async () => {
    const queue = new TaskQueue({ maxSize: 10 });
    const scheduler = new TaskScheduler(
      { maxConcurrentTasks: 1, taskQueueSize: 10, schedulerIntervalMs: 5 },
      queue,
      new ConcurrentTaskManager(1),
      async function* () {
        yield JSON.stringify({ type: "done" });
      },
    );

    queue.enqueue("session-1", "auto complete");
    scheduler.start();

    try {
      await waitFor(() => queue.getStats().completed === 1);
      expect(queue.getStats()).toMatchObject({
        pending: 0,
        running: 0,
        completed: 1,
      });
      expect(scheduler.getStats().processed).toBe(1);
    } finally {
      scheduler.stop();
    }
  });

  it("should fail queued tasks when the executor throws", async () => {
    const queue = new TaskQueue({ maxSize: 10 });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const scheduler = new TaskScheduler(
      { maxConcurrentTasks: 1, taskQueueSize: 10, schedulerIntervalMs: 5 },
      queue,
      new ConcurrentTaskManager(1),
      async function* () {
        throw new Error("queued failure");
      },
    );

    queue.enqueue("session-1", "auto fail");
    scheduler.start();

    try {
      await waitFor(() => queue.getCompletedTasks()[0]?.status === "failed");
      expect(queue.getCompletedTasks()[0]).toMatchObject({
        status: "failed",
        error: "queued failure",
      });
      expect(scheduler.getStats().failed).toBe(1);
    } finally {
      scheduler.stop();
      errorSpy.mockRestore();
    }
  });

  it("should execute due scheduled tasks and keep recurring tasks pending", async () => {
    const queue = new TaskQueue({ maxSize: 10 });
    const manager = new ConcurrentTaskManager(1);
    let runs = 0;

    const scheduler = new TaskScheduler(
      { maxConcurrentTasks: 1, taskQueueSize: 10, schedulerIntervalMs: 5 },
      queue,
      manager,
      async function* () {
        const release = await manager.acquire();
        try {
          runs++;
          yield JSON.stringify({ type: "done" });
        } finally {
          release();
        }
      },
    );

    const scheduled = scheduler.schedule(
      "session-1",
      "recurring",
      "every 1 seconds",
      Date.now(),
    );
    scheduler.start();

    try {
      await waitFor(
        () =>
          runs === 1 &&
          (scheduler.getScheduledTasks()[0]?.runAt ?? 0) > Date.now(),
      );
      const scheduledTasks = scheduler.getScheduledTasks();
      expect(scheduledTasks.some((task) => task.id === scheduled.id)).toBe(
        true,
      );
      expect(scheduledTasks[0].runAt).toBeGreaterThan(Date.now());
      expect(scheduler.getStats().processed).toBe(1);
    } finally {
      scheduler.stop();
    }
  });

  it("should recover persisted pending and stale running scheduled tasks", () => {
    const db = new Database(":memory:");
    try {
      const store = new SqliteScheduledTaskStore(db);
      const original = new TaskScheduler(
        { maxConcurrentTasks: 1, taskQueueSize: 10 },
        undefined,
        undefined,
        undefined,
        store,
      );
      const pending = original.schedule(
        "session-1",
        "pending message",
        undefined,
        Date.now() + 10_000,
      );
      const running = original.schedule(
        "session-1",
        "running message",
        undefined,
        Date.now(),
      );
      running.status = "running";
      running.lastRunAt = Date.now() - 60_000;
      store.upsertTask(running);

      const recovered = new TaskScheduler(
        {
          maxConcurrentTasks: 1,
          taskQueueSize: 10,
          recoveryStaleAfterMs: 1_000,
        },
        undefined,
        undefined,
        undefined,
        store,
      );

      expect(recovered.recoverPersistedTasks()).toBe(1);
      const active = recovered.getScheduledTasks();
      expect(active.map((task) => task.id).sort()).toEqual(
        [pending.id, running.id].sort(),
      );
      expect(recovered.getScheduledTask(running.id)?.status).toBe("pending");
      expect(recovered.getStats().recovered).toBe(1);
    } finally {
      db.close();
    }
  });

  it("should persist retry backoff for failed scheduled tasks", async () => {
    const db = new Database(":memory:");
    try {
      const store = new SqliteScheduledTaskStore(db);
      const scheduler = new TaskScheduler(
        {
          maxConcurrentTasks: 1,
          taskQueueSize: 10,
          schedulerIntervalMs: 5,
          retryBaseDelayMs: 10_000,
          maxScheduledTaskAttempts: 2,
        },
        undefined,
        undefined,
        async function* () {
          throw new Error("boom");
        },
        store,
      );

      const scheduled = scheduler.schedule(
        "session-1",
        "retry me",
        undefined,
        Date.now(),
      );
      scheduler.start();

      try {
        await waitFor(() => scheduler.getStats().failed === 1);
      } finally {
        scheduler.stop();
      }

      const persisted = store.loadTask(scheduled.id);
      expect(persisted?.status).toBe("pending");
      expect(persisted?.attempts).toBe(1);
      expect(persisted?.lastError).toBe("boom");
      expect(persisted?.runAt).toBeGreaterThan(Date.now());
      expect(scheduler.getStats().retried).toBe(1);
    } finally {
      db.close();
    }
  });

  it("should dead-letter scheduled tasks after max attempts", async () => {
    const db = new Database(":memory:");
    try {
      const store = new SqliteScheduledTaskStore(db);
      const scheduler = new TaskScheduler(
        {
          maxConcurrentTasks: 1,
          taskQueueSize: 10,
          schedulerIntervalMs: 5,
          maxScheduledTaskAttempts: 1,
        },
        undefined,
        undefined,
        async function* () {
          throw new Error("terminal failure");
        },
        store,
      );

      const scheduled = scheduler.schedule(
        "session-1",
        "dead letter me",
        undefined,
        Date.now(),
      );
      scheduler.start();

      try {
        await waitFor(() => scheduler.getStats().deadLettered === 1);
      } finally {
        scheduler.stop();
      }

      const persisted = store.loadTask(scheduled.id);
      expect(persisted?.status).toBe("dead_letter");
      expect(persisted?.attempts).toBe(1);
      expect(persisted?.completedAt).toBeDefined();
      expect(scheduler.getScheduledTasks()).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("LiteLLM config", () => {
  const previousMasterKey = process.env["LITELLM_MASTER_KEY"];
  const providers = [
    {
      id: "google",
      default_api_base:
        "https://generativelanguage.googleapis.com/v1beta/openai/",
      empty_api_key_allowed: false,
    },
    {
      id: "openrouter",
      default_api_base: "https://openrouter.ai/api/v1",
      empty_api_key_allowed: false,
    },
  ];

  beforeEach(() => {
    process.env["LITELLM_MASTER_KEY"] = "test-litellm-master-key";
  });

  afterEach(() => {
    if (previousMasterKey === undefined) {
      delete process.env["LITELLM_MASTER_KEY"];
    } else {
      process.env["LITELLM_MASTER_KEY"] = previousMasterKey;
    }
  });

  it("should resolve LiteLLM master keys without requiring prebuilt env values", () => {
    delete process.env["LITELLM_MASTER_KEY"];
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Hiro-litellm-"),
    );
    const key = resolveLiteLLMMasterKey({
      workspaceDir,
      filePath: "",
    });

    expect(key.length).toBeGreaterThanOrEqual(43);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("should create Google aliases compatible with the core model mapper", () => {
    const result = buildLiteLLMConfig(
      [
        {
          model_name: "google/gemini-2.0-flash-001",
          provider: "google",
          model: "gemini-2.0-flash-001",
        },
      ],
      providers,
    );

    const modelList = result.config.model_list as Array<{
      model_name: string;
      litellm_params: Record<string, unknown>;
    }>;
    expect(modelList.map((entry) => entry.model_name)).toEqual([
      "google/gemini-2.0-flash-001",
      "gemini/gemini-2.0-flash-001",
    ]);
    expect(modelList[0].litellm_params.model).toBe(
      "gemini/gemini-2.0-flash-001",
    );
    expect(modelList[0].litellm_params.api_key).toBe(
      "os.environ/GEMINI_API_KEY",
    );
    expect(modelList[0].litellm_params.api_base).toBeUndefined();
  });

  it("should map OpenRouter models without writing raw secrets", () => {
    const result = buildLiteLLMConfig(
      [
        {
          model_name: "openrouter/anthropic/claude-3.5-sonnet",
          provider: "openrouter",
          model: "anthropic/claude-3.5-sonnet",
        },
      ],
      providers,
    );

    const modelList = result.config.model_list as Array<{
      model_name: string;
      litellm_params: Record<string, unknown>;
    }>;
    expect(modelList).toHaveLength(1);
    expect(modelList[0].litellm_params.model).toBe(
      "openrouter/anthropic/claude-3.5-sonnet",
    );
    expect(modelList[0].litellm_params.api_key).toBe(
      "os.environ/OPENROUTER_API_KEY",
    );
    expect(JSON.stringify(result.config)).not.toContain("OPENROUTER_API_KEY=");
  });

  it("should repair OpenRouter catalog models with stale provider metadata", () => {
    const result = buildLiteLLMConfig(
      [
        {
          model_name: "meta-llama/llama-3.3-70b-instruct",
          provider: "anthropic",
          model: "llama-3.3-70b-instruct",
        },
      ],
      providers,
    );

    const modelList = result.config.model_list as Array<{
      model_name: string;
      litellm_params: Record<string, unknown>;
    }>;
    expect(modelList).toHaveLength(1);
    expect(modelList[0].litellm_params.model).toBe(
      "openrouter/meta-llama/llama-3.3-70b-instruct",
    );
    expect(modelList[0].litellm_params.api_key).toBe(
      "os.environ/OPENROUTER_API_KEY",
    );
  });
});
