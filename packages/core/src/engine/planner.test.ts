import { createPlan, fallbackPlan, parsePlanJson } from "./planner.js";
import { scriptedLLM } from "./__tests__/scripted-llm.js";

describe("fallbackPlan", () => {
  it("is a single internal step that does not inspect the wording", () => {
    for (const goal of ["hi there", "ফাইল পড়ো তারপর ঠিক করো", "Read the file and then fix it"]) {
      const plan = fallbackPlan(goal);
      expect(plan.source).toBe("heuristic");
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].status).toBe("pending");
    }
  });
});

describe("parsePlanJson", () => {
  const known = new Set(["file_read"]);
  it("parses fenced JSON, drops unknown tools and caps the step count", () => {
    const steps = parsePlanJson(
      'Sure!\n```json\n{"steps":[{"title":"Read","tool":"file_read"},{"title":"Think","tool":"made_up"},"Summarize"]}\n```',
      known,
      2,
    );
    expect(steps).toEqual([{ title: "Read", tool: "file_read" }, { title: "Think" }]);
  });
  it("returns null for invalid replies", () => {
    expect(parsePlanJson("no json here", known)).toBeNull();
    expect(parsePlanJson('{"steps": "nope"}', known)).toBeNull();
    expect(parsePlanJson('{"steps": []}', known)).toBeNull();
  });
});

describe("createPlan", () => {
  const goal = "Search the repo for the bug, then fix it and run the tests";
  it("uses the model plan for multi-step goals", async () => {
    const { client } = scriptedLLM([{ text: '{"steps":[{"title":"Search"},{"title":"Fix"},{"title":"Test"}]}' }]);
    const plan = await createPlan({ goal, llm: client, toolNames: [] });
    expect(plan.source).toBe("llm");
    expect(plan.steps.map((s) => s.title)).toEqual(["Search", "Fix", "Test"]);
  });
  it("falls back to the minimal plan when the model fails or replies badly", async () => {
    const onFallback = jest.fn();
    const failing = scriptedLLM([{ error: "boom" }]);
    expect((await createPlan({ goal, llm: failing.client, toolNames: [], onFallback })).source).toBe("heuristic");
    const garbage = scriptedLLM([{ text: "I refuse" }]);
    expect((await createPlan({ goal, llm: garbage.client, toolNames: [], onFallback })).source).toBe("heuristic");
    expect(onFallback).toHaveBeenCalledTimes(2);
  });
  it("always asks the model, even for short or simple requests", async () => {
    const { client, requests } = scriptedLLM([{ text: '{"complexity":"trivial","steps":[{"title":"Answer directly"}]}' }]);
    const plan = await createPlan({ goal: "hi", llm: client, toolNames: [] });
    expect(requests).toHaveLength(1);
    expect(plan.source).toBe("llm");
    expect(plan.complexity).toBe("trivial");
    expect(plan.steps).toHaveLength(1);
  });
});
