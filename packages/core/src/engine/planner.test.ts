import { analyzeGoal, createPlan, heuristicPlan, parsePlanJson } from "./planner.js";
import { scriptedLLM } from "./__tests__/scripted-llm.js";

describe("analyzeGoal", () => {
  it("treats short chit-chat as trivial", () => {
    expect(analyzeGoal("hello, how are you?").complexity).toBe("trivial");
    expect(analyzeGoal("তোমার নাম কি?").complexity).toBe("trivial");
  });
  it("detects Bengali and English work requests", () => {
    expect(analyzeGoal("ফাইল পড়ো").complexity).toBe("simple");
    expect(analyzeGoal("Read the config file").complexity).toBe("simple");
  });
  it("detects multi-step goals", () => {
    expect(analyzeGoal("Search the repo for the bug, then fix it and run the tests").complexity).toBe("multi_step");
    expect(analyzeGoal("প্রথমে ফাইল পড়ো তারপর সমস্যা খুঁজে বের করো").complexity).toBe("multi_step");
  });
});

describe("heuristicPlan", () => {
  it("splits a sequenced goal into steps", () => {
    const plan = heuristicPlan("Read the config file and then check the model setting, then fix any error");
    expect(plan.source).toBe("heuristic");
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(plan.steps.every((s) => s.status === "pending")).toBe(true);
  });
  it("returns a single no-op step for trivial goals", () => {
    const plan = heuristicPlan("hi there");
    expect(plan.source).toBe("none");
    expect(plan.steps).toHaveLength(1);
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
  it("falls back to the heuristic plan when the model fails or replies badly", async () => {
    const onFallback = jest.fn();
    const failing = scriptedLLM([{ error: "boom" }]);
    expect((await createPlan({ goal, llm: failing.client, toolNames: [], onFallback })).source).toBe("heuristic");
    const garbage = scriptedLLM([{ text: "I refuse" }]);
    expect((await createPlan({ goal, llm: garbage.client, toolNames: [], onFallback })).source).toBe("heuristic");
    expect(onFallback).toHaveBeenCalledTimes(2);
  });
  it("does not call the model for simple goals", async () => {
    const { client, requests } = scriptedLLM([{ text: "{}" }]);
    await createPlan({ goal: "Read the config file", llm: client, toolNames: [] });
    expect(requests).toHaveLength(0);
  });
});
