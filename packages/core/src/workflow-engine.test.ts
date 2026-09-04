import { AgentRunRecorder, InMemoryAgentRunStore } from "./agent-run.js";
import { WorkflowEngine } from "./workflow-engine.js";

describe("WorkflowEngine", () => {
  it("runs planner, executor and verifier with persisted evidence", async () => {
    const store = new InMemoryAgentRunStore();
    const recorder = new AgentRunRecorder(store);
    const engine = new WorkflowEngine(recorder);
    const run = await engine.run({
      objective: "produce a verified result",
      planner: {
        plan: async () => [
          { id: "plan", title: "Plan" },
          { id: "execute", title: "Execute" },
        ],
      },
      executor: {
        execute: async (step) => ({ ok: true, summary: `Executed ${step.id}` }),
      },
      verifier: {
        verify: async (_step, result) => ({
          kind: "metric",
          summary: result.summary,
          ok: result.ok,
          source: "test",
        }),
      },
    });
    expect(run.status).toBe("completed");
    expect(run.steps).toHaveLength(2);
    expect(run.steps.every((step) => step.status === "completed")).toBe(true);
    expect(run.steps[0]?.evidence.length).toBeGreaterThanOrEqual(3);
  });

  it("stops after failed verifier evidence", async () => {
    const engine = new WorkflowEngine(
      new AgentRunRecorder(new InMemoryAgentRunStore()),
    );
    const run = await engine.run({
      objective: "stop on failed verification",
      planner: {
        plan: async () => [
          { id: "first", title: "First" },
          { id: "second", title: "Second" },
        ],
      },
      executor: {
        execute: async () => ({ ok: true, summary: "executed" }),
      },
      verifier: {
        verify: async () => ({
          kind: "manual",
          summary: "verification failed",
          ok: false,
          source: "test",
        }),
      },
    });
    expect(run.status).toBe("failed");
    expect(run.steps[0]?.status).toBe("failed");
    expect(run.steps[1]?.status).toBe("pending");
  });
});
