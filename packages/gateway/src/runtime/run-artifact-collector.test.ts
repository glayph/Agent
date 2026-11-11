import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunArtifactCollector } from "./run-artifact-collector.js";
import type { AgentPlan, EngineEvent, ToolCallRecord } from "@miki/core/engine";

describe("RunArtifactCollector", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "miki-artifacts-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes backend-only cache categories, maintains temporary plan/todo files, redacts secrets, and cleans completed goals", async () => {
    const collector = new RunArtifactCollector(root);
    const runId = "goal:42";
    const goal = "Create a report; password=hunter2";
    const plan: AgentPlan = {
      id: "plan-42",
      goal,
      source: "llm",
      complexity: "multi_step",
      createdAt: new Date().toISOString(),
      steps: [
        { id: "s1", title: "Create the report", tool: "write_file", status: "pending" },
        { id: "s2", title: "Verify the report", tool: "read_file", status: "pending", dependsOn: ["s1"] },
      ],
    };

    collector.record({ type: "run.started", runId, model: "test-model", goal, at: new Date().toISOString() } as EngineEvent, goal);
    collector.record({ type: "plan.created", runId, plan } as EngineEvent, goal);
    await collector.flush();

    const goalDir = path.join(root, "Runtime", "Goals", "goal_42");
    expect(await fs.readFile(path.join(goalDir, "plan.md"), "utf8")).toContain("Create the report");
    expect(await fs.readFile(path.join(goalDir, "todo.md"), "utf8")).toContain("Progress: 0% (0/2 verified steps)");

    const call: ToolCallRecord = {
      id: "call-1",
      name: "write_file",
      arguments: JSON.stringify({ path: "report.txt", api_key: "secret-value" }),
      risk: "config_write",
      status: "succeeded",
      turn: 1,
      startedAt: new Date().toISOString(),
      interrupted: false,
      resultPreview: "created",
      actionVerification: { status: "verified", reason: "File exists", evidence: ["read_file returned report.txt"] },
    };
    collector.record({ type: "tool.call", runId, turn: 1, call } as EngineEvent, goal);
    collector.record({ type: "run.phase", runId, turn: 1, phase: "verification", status: "completed", detail: "File exists" } as EngineEvent, goal);
    collector.record({
      type: "user.steer", runId, turn: 1, count: 1, messageIds: ["steer-1"],
      items: [{ messageId: "steer-1", receivedAt: new Date().toISOString(), text: "Also make it concise", imageCount: 0 }],
    } as EngineEvent, goal);
    collector.record({ type: "plan.updated", runId, plan: { ...plan, steps: [{ ...plan.steps[0], status: "done" }, { ...plan.steps[1], status: "done" }] } } as EngineEvent, goal);
    await collector.flush();

    const actionDir = path.join(root, "Cache", "actions");
    const actionFiles = await fs.readdir(actionDir);
    const actionData = await fs.readFile(path.join(actionDir, actionFiles[0]), "utf8");
    expect(actionData).toContain("report.txt");
    expect(actionData).not.toContain("secret-value");

    const userDir = path.join(root, "Cache", "user-input");
    const userData = (await Promise.all((await fs.readdir(userDir)).map((name) => fs.readFile(path.join(userDir, name), "utf8")))).join("\n");
    expect(userData).toContain("[REDACTED]");
    expect(userData).not.toContain("hunter2");
    expect(await fs.readdir(path.join(root, "Cache", "verification"))).toHaveLength(1);
    expect(await fs.readdir(path.join(root, "Cache", "plans"))).toHaveLength(1);
    expect(await fs.readdir(path.join(root, "Cache", "todo"))).toHaveLength(1);

    collector.record({
      type: "run.finished", runId, status: "completed", turns: 2, toolCalls: 1,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    } as EngineEvent, goal);
    await collector.flush();

    await expect(fs.access(goalDir)).rejects.toThrow();
    expect(await fs.readdir(path.join(root, "Cache", "events"))).toHaveLength(1);
  });

  it("preserves unfinished temporary goal files for recovery", async () => {
    const collector = new RunArtifactCollector(root);
    const plan: AgentPlan = {
      id: "plan-recovery", goal: "Recover a task", source: "llm", complexity: "simple",
      createdAt: new Date().toISOString(), steps: [{ id: "s1", title: "Run the task", status: "running" }],
    };
    collector.record({ type: "plan.created", runId: "unfinished-run", plan } as EngineEvent, plan.goal);
    collector.record({ type: "plan.updated", runId: "unfinished-run", plan: { ...plan, steps: [{ ...plan.steps[0], status: "failed" }] } } as EngineEvent, plan.goal);
    collector.record({ type: "run.finished", runId: "unfinished-run", status: "completed", turns: 1, toolCalls: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } as EngineEvent, plan.goal);
    await collector.flush();
    await expect(fs.readFile(path.join(root, "Runtime", "Goals", "unfinished-run", "plan.md"), "utf8")).resolves.toContain("Run the task");
  });
});
