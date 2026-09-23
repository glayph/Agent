import {
  WorkflowEngine,
  InMemoryWorkflowStateStore,
  SqliteWorkflowStateStore,
  type WorkflowRunInput,
} from "./workflow-engine.js";
import Database from "better-sqlite3";

function input(overrides: Partial<WorkflowRunInput> = {}): WorkflowRunInput {
  return {
    objective: "complete the task",
    planner: {
      plan: async () => [
        { id: "one", title: "First" },
        { id: "two", title: "Second" },
      ],
    },
    executor: {
      execute: async (step) => ({ ok: true, summary: `done ${step.id}` }),
    },
    verifier: {
      verify: async (_step, result) => ({
        kind: "manual",
        summary: result.summary,
        ok: result.ok,
      }),
    },
    ...overrides,
  };
}

describe("durable autonomous WorkflowEngine", () => {
  it("runs a normal single task through plan, execute, observe and verify", async () => {
    const engine = new WorkflowEngine();
    const run = await engine.run(input());
    expect(run.status).toBe("completed");
    expect(run.steps.every((step) => step.status === "completed")).toBe(true);
  });
  it("continues across multiple autonomous steps and persists context/memory", async () => {
    const store = new InMemoryWorkflowStateStore();
    const seen: unknown[] = [];
    const engine = new WorkflowEngine(undefined, store);
    await engine.run(
      input({
        contextProvider: async () => ({ ticket: "T-1" }),
        memoryProvider: async () => ({ prior: "fact" }),
        executor: {
          execute: async (_step, context) => {
            seen.push([context.context, context.memory]);
            return { ok: true, summary: "ok" };
          },
        },
        taskId: "multi-step",
      }),
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual([{ ticket: "T-1" }, { prior: "fact" }]);
    expect(store.get("multi-step")?.cursor).toBe(2);
  });
  it("persists a discoverable planning state and stable step idempotency key", async () => {
    const store = new InMemoryWorkflowStateStore();
    const seen: string[] = [];
    const engine = new WorkflowEngine(undefined, store);
    await engine.run(
      input({
        taskId: "planning-checkpoint",
        contextProvider: async () => ({ source: "test" }),
        executor: {
          execute: async (_step, context) => {
            seen.push(context.idempotencyKey);
            return { ok: true, summary: "ok" };
          },
        },
      }),
    );
    expect(seen).toEqual(["planning-checkpoint:one", "planning-checkpoint:two"]);
    expect(store.get("planning-checkpoint")?.status).toBe("completed");
  });
  it("diagnoses a failed tool, recovers, retries, and continues", async () => {
    let calls = 0;
    let recoveries = 0;
    const engine = new WorkflowEngine();
    const run = await engine.run(
      input({
        maxRetries: 1,
        executor: {
          execute: async () => {
            calls += 1;
            if (calls === 1) throw new Error("transient tool error");
            return { ok: true, summary: "recovered" };
          },
        },
        recover: async () => {
          recoveries += 1;
        },
      }),
    );
    expect(run.status).toBe("completed");
    expect(calls).toBe(3);
    expect(recoveries).toBe(1);
  });
  it("checkpoints an interrupted task and resumes from the next step", async () => {
    const store = new InMemoryWorkflowStateStore();
    const controller = new AbortController();
    const engine = new WorkflowEngine(undefined, store);
    await expect(
      engine.run(
        input({
          taskId: "resume-me",
          signal: controller.signal,
          executor: {
            execute: async (step) => {
              if (step.id === "two") controller.abort();
              return { ok: true, summary: "ok" };
            },
          },
        }),
      ),
    ).rejects.toThrow("Workflow aborted");
    expect(store.get("resume-me")?.cursor).toBe(1);
    const resumed = await engine.resume(
      "resume-me",
      input({
        executor: { execute: async () => ({ ok: true, summary: "resumed" }) },
      }),
    );
    expect(resumed.status).toBe("completed");
    expect(store.get("resume-me")?.cursor).toBe(2);
  });
  it("runs detached work in the background and exposes durable progress", async () => {
    const store = new InMemoryWorkflowStateStore();
    const engine = new WorkflowEngine(undefined, store);
    const handle = engine.startBackground(input({ taskId: "background" }));
    expect(handle.taskId).toBe("background");
    await handle.promise;
    expect(store.get("background")?.status).toBe("completed");
  });
  it("prevents duplicate concurrent execution of the same task", async () => {
    let plannerCalls = 0;
    let executeCalls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = new WorkflowEngine();
    const first = engine.run(
      input({
        taskId: "single-flight",
        planner: {
          plan: async () => {
            plannerCalls += 1;
            return [{ id: "one", title: "First" }];
          },
        },
        executor: {
          execute: async () => {
            executeCalls += 1;
            await gate;
            return { ok: true, summary: "ok" };
          },
        },
      }),
    );
    const second = engine.run(input({ taskId: "single-flight" }));
    expect(first).toBe(second);
    release?.();
    await first;
    expect(plannerCalls).toBe(1);
    expect(executeCalls).toBe(1);
  });
  it("uses an atomic SQLite lease across workers", async () => {
    const db = new Database(":memory:");
    const store = new SqliteWorkflowStateStore(db);
    const first = new WorkflowEngine(undefined, store);
    const second = new WorkflowEngine(undefined, store);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = first.run(
      input({
        taskId: "leased-workflow",
        executor: {
          execute: async () => {
            await gate;
            return { ok: true, summary: "ok" };
          },
        },
      }),
    );
    expect(() => second.run(input({ taskId: "leased-workflow" }))).toThrow(
      "currently leased",
    );
    release?.();
    await running;
    db.close();
  });
});
