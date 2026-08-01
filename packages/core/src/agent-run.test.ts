import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AgentRunRecorder,
  InMemoryAgentRunStore,
  SqliteAgentRunStore,
  createTaskGraph,
  exportAgentRunBundle,
  importAgentRunBundle,
} from "./agent-run.js";

describe("agent run recorder", () => {
  it("tracks a task graph with verification evidence", () => {
    const recorder = new AgentRunRecorder(new InMemoryAgentRunStore());
    const run = recorder.create("ship feature", ["code", "verify"]);

    recorder.startStep(run.id, "step-1");
    recorder.completeStep(run.id, "step-1", {
      kind: "file",
      summary: "implementation changed",
      ok: true,
    });
    const finalRun = recorder.completeStep(run.id, "step-2", {
      kind: "command",
      summary: "tests passed",
      ok: true,
    });

    expect(finalRun.status).toBe("completed");
    expect(finalRun.steps[1].evidence[0].summary).toBe("tests passed");
    expect(recorder.list()).toHaveLength(1);
  });

  it("marks a run failed when verification evidence fails", () => {
    const recorder = new AgentRunRecorder();
    const run = recorder.create("ship feature", ["verify"]);
    const failed = recorder.completeStep(run.id, "step-1", {
      kind: "command",
      summary: "tests failed",
      ok: false,
    });

    expect(failed.status).toBe("failed");
  });

  it("persists runs in sqlite and exports redacted evidence bundles", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-runs-"));
    const dbPath = path.join(tempDir, "agent-runs.db");
    const recorder = new AgentRunRecorder(new SqliteAgentRunStore(dbPath));
    const run = recorder.create("ship secure feature", ["code"]);

    recorder.startStep(run.id, "step-1");
    recorder.completeStep(run.id, "step-1", {
      kind: "command",
      summary: "tests passed",
      ok: true,
      data: { api_key: "sk-test-secret-value-1234567890" },
    });
    recorder.recordContextSnapshot(run.id, {
      contextBudget: { usedTokens: 1200, maxTokens: 4096 },
      retrievalDiagnostics: { returned: 4, elapsedMs: 3 },
    });

    const recovered = new AgentRunRecorder(new SqliteAgentRunStore(dbPath));
    const saved = recovered.get(run.id);

    expect(saved?.status).toBe("completed");
    expect(saved?.steps[0].evidence[0].summary).toBe("tests passed");
    expect(saved?.timeline?.length).toBeGreaterThan(0);
    expect(saved?.contextBudget).toMatchObject({ usedTokens: 1200 });
    expect(saved?.retrievalDiagnostics).toMatchObject({ returned: 4 });
    expect(JSON.stringify(exportAgentRunBundle(saved!))).not.toContain(
      "sk-test-secret-value-1234567890",
    );
  });

  it("patches step state and appends evidence without losing history", () => {
    const recorder = new AgentRunRecorder(new InMemoryAgentRunStore());
    const run = recorder.create("debug run", ["inspect"]);

    const running = recorder.patchStep(run.id, "step-1", {
      status: "running",
      evidence: {
        kind: "manual",
        summary: "operator started inspection",
        ok: true,
      },
    });
    const completed = recorder.patchStep(run.id, "step-1", {
      status: "completed",
      evidence: {
        kind: "file",
        summary: "report captured",
        ok: true,
      },
    });

    expect(running.steps[0].attempts).toBe(1);
    expect(completed.status).toBe("completed");
    expect(completed.steps[0].evidence).toHaveLength(2);
  });

  it("blocks dependent steps until their prerequisites are completed", () => {
    const recorder = new AgentRunRecorder(new InMemoryAgentRunStore());
    const run = recorder.create("ship ordered workflow", ["code", "verify"]);

    expect(() => recorder.startStep(run.id, "step-2")).toThrow(
      "blocked by incomplete dependencies",
    );
    expect(() =>
      recorder.completeStep(run.id, "step-2", {
        kind: "command",
        summary: "premature verification",
        ok: true,
      }),
    ).toThrow("blocked by incomplete dependencies");

    recorder.completeStep(run.id, "step-1", {
      kind: "file",
      summary: "implementation landed",
      ok: true,
    });
    const running = recorder.startStep(run.id, "step-2");

    expect(running.status).toBe("running");
    expect(running.steps[1].attempts).toBe(1);
  });

  it("keeps empty task graphs pending instead of marking them completed", () => {
    expect(createTaskGraph("empty workflow", []).status).toBe("pending");
  });

  it("normalizes graph labels and bounds evidence payloads", () => {
    const recorder = new AgentRunRecorder(new InMemoryAgentRunStore());
    const run = recorder.create("  ship   evidence  ", [
      "  inspect   state ",
      "   ",
      " verify ",
    ]);

    const completed = recorder.completeStep(run.id, "step-1", {
      kind: "metric",
      summary: `  ${"x".repeat(2500)}  `,
      ok: true,
      data: {
        api_key: "sk-test-secret-value-1234567890",
        blob: "y".repeat(25_000),
      },
    });

    expect(completed.objective).toBe("ship evidence");
    expect(completed.steps.map((step) => step.title)).toEqual([
      "inspect state",
      "verify",
    ]);
    const evidence = completed.steps[0].evidence[0];
    expect(evidence.summary).toHaveLength(2000);
    expect(evidence.data).toMatchObject({ truncated: true });
    expect(JSON.stringify(evidence.data)).not.toContain(
      "sk-test-secret-value-1234567890",
    );
  });

  it("records planner, model, tool, and verifier trace metadata", () => {
    const recorder = new AgentRunRecorder(new InMemoryAgentRunStore());
    const run = recorder.create("trace execution", ["plan", "execute"]);

    recorder.recordPlannerStep(run.id, "step-1", "planner chose path", {
      api_key: "sk-test-secret-value-1234567890",
    });
    recorder.completeStep(run.id, "step-1", {
      kind: "manual",
      summary: "plan accepted",
      ok: true,
      phase: "planner",
      source: "planner",
    });
    recorder.startStep(run.id, "step-2");
    recorder.recordModelCall(run.id, "step-2", {
      provider: "openai",
      model: "gpt-test",
      inputTokens: 12,
      outputTokens: 34,
    });
    const traced = recorder.recordToolCall(run.id, "step-2", {
      toolName: "shell_execute",
      status: "denied",
      permission: {
        toolName: "shell_execute",
        decision: "denied",
        reason: "workspace policy",
      },
    });

    expect(traced.status).toBe("failed");
    expect(traced.timeline?.length).toBeGreaterThan(0);
    expect(traced.steps[1].evidence.at(-1)?.permission?.decision).toBe(
      "denied",
    );
    expect(JSON.stringify(traced)).not.toContain(
      "sk-test-secret-value-1234567890",
    );
  });

  it("exports v2 replay bundles and imports v1 bundles", () => {
    const recorder = new AgentRunRecorder(new InMemoryAgentRunStore());
    const run = recorder.create("export trace", ["verify"]);
    const completed = recorder.completeStep(run.id, "step-1", {
      kind: "command",
      summary: "verify passed",
      ok: true,
      source: "test",
      phase: "verifier",
    });

    const bundle = exportAgentRunBundle(completed);
    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.replay?.steps[0].evidenceCount).toBe(1);

    const imported = importAgentRunBundle({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      run: {
        id: "legacy",
        objective: "legacy run",
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            id: "step-1",
            title: "legacy step",
            dependsOn: [],
            status: "completed",
            attempts: 1,
            evidence: [
              {
                kind: "manual",
                summary: "legacy evidence",
                ok: true,
              },
            ],
          },
        ],
      },
    });

    expect(imported?.id).toBe("legacy");
    expect(imported?.steps[0].evidence[0].summary).toBe("legacy evidence");
  });
});
