import { appendPlanSteps, sanitizeAddedSteps, MAX_ADDED_PLAN_STEPS } from "./planner.js";
import type { AgentPlan } from "./types.js";

const NOW = "2026-11-12T00:00:00.000Z";

describe("sanitizeAddedSteps", () => {
  it("ignores non-array input and non-string entries", () => {
    expect(sanitizeAddedSteps(undefined)).toEqual([]);
    expect(sanitizeAddedSteps("add a summary")).toEqual([]);
    expect(sanitizeAddedSteps([1, null, { title: "x" }, "  "])).toEqual([]);
  });

  it("trims titles, bounds their length, and caps the number of steps", () => {
    const long = "x".repeat(500);
    const out = sanitizeAddedSteps(["  Write the report  ", long, "b", "c", "d", "e", "f", "g"]);
    expect(out[0]).toBe("Write the report");
    expect(out[1]).toHaveLength(200);
    expect(out).toHaveLength(MAX_ADDED_PLAN_STEPS);
  });
});

describe("appendPlanSteps", () => {
  const existing: AgentPlan = {
    id: "plan_1",
    goal: "Fix the build",
    source: "llm",
    complexity: "multi_step",
    createdAt: NOW,
    steps: [
      { id: "s1", title: "Read the log", status: "done" },
      { id: "s2", title: "Patch the parser", status: "running" },
    ],
  };

  it("appends new steps as pending and keeps finished work untouched", () => {
    const next = appendPlanSteps(existing, "Fix the build", ["Also update the docs"], NOW);
    expect(next.steps.map((s) => [s.title, s.status])).toEqual([
      ["Read the log", "done"],
      ["Patch the parser", "running"],
      ["Also update the docs", "pending"],
    ]);
    expect(next.id).toBe("plan_1");
  });

  it("does not mutate the plan it was given", () => {
    const before = JSON.stringify(existing);
    appendPlanSteps(existing, "Fix the build", ["Extra"], NOW);
    expect(JSON.stringify(existing)).toBe(before);
  });

  it("creates a multi-step plan when the run had none", () => {
    const next = appendPlanSteps(undefined, "Build the site", ["Add a contact page"], NOW);
    expect(next.goal).toBe("Build the site");
    expect(next.source).toBe("llm");
    expect(next.complexity).toBe("multi_step");
    expect(next.steps).toHaveLength(1);
    expect(next.steps[0].status).toBe("pending");
  });

  it("upgrades a trivial plan so the added work is tracked as a real plan", () => {
    const trivial: AgentPlan = { ...existing, source: "none", complexity: "trivial", steps: [] };
    const next = appendPlanSteps(trivial, "Say hi", ["Also translate it"], NOW);
    expect(next.source).toBe("llm");
    expect(next.complexity).toBe("multi_step");
  });
});
