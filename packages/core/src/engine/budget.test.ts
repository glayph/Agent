import { AgentEngine } from "./agent-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { assessProgress } from "./budget.js";
import { scriptedLLM } from "./__tests__/scripted-llm.js";
import type { EngineMessage, EngineTool, ToolCallRecord } from "./types.js";

const record = (name: string, args: string, status: ToolCallRecord["status"], error?: string): ToolCallRecord => ({
  id: `${name}${args}`,
  name,
  arguments: args,
  risk: "read",
  status,
  turn: 1,
  startedAt: "",
  ...(error ? { error } : {}),
});

function tool(overrides: Partial<EngineTool> & { name: string }): EngineTool {
  return {
    description: overrides.name,
    risk: "read",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: () => ({ ok: true }),
    ...overrides,
  };
}
const user = (content: string): EngineMessage[] => [{ role: "user", content }];
const stepCalls = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ calls: [{ name: "step", args: { n: i } }] }));

describe("assessProgress", () => {
  it("is productive when recent calls succeeded and differ", () => {
    const records = [record("a", "1", "failed"), record("a", "2", "succeeded"), record("b", "3", "succeeded"), record("c", "4", "succeeded")];
    expect(assessProgress(records).productive).toBe(true);
  });

  it("is not productive when failing, looping, or too short", () => {
    expect(assessProgress([record("a", "1", "failed"), record("a", "2", "succeeded")]).productive).toBe(false);
    expect(assessProgress([record("a", "1", "succeeded"), record("a", "1", "succeeded"), record("a", "1", "succeeded"), record("a", "1", "succeeded")]).productive).toBe(false);
    expect(assessProgress([record("a", "1", "succeeded")]).productive).toBe(false);
    expect(assessProgress([record("a", "1", "succeeded"), record("b", "2", "succeeded"), record("c", "3", "failed")]).productive).toBe(false);
  });

  it("ignores calls that were only skipped because a budget ended", () => {
    const records = [
      record("a", "1", "succeeded"),
      record("b", "2", "succeeded"),
      record("c", "3", "blocked", "Tool call budget of 2 reached."),
      record("d", "4", "blocked", "Tool call budget of 2 reached."),
    ];
    expect(assessProgress(records, { ignore: (r) => r.error === "Tool call budget of 2 reached." }).productive).toBe(true);
    expect(assessProgress(records).productive).toBe(false);
  });
});

describe("engine dynamic budget", () => {
  const registry = (execute?: EngineTool["execute"]) => {
    const r = new ToolRegistry();
    r.register(tool({ name: "step", ...(execute ? { execute } : {}) }));
    return r;
  };
  const base = { maxTurns: 3, maxToolIterations: 3, maxToolCalls: 100 };

  it("stops at the limit when the feature is off", async () => {
    const llm = scriptedLLM([...stepCalls(5), { text: "done" }]);
    const result = await new AgentEngine({ llm: llm.client, tools: registry(), ...base }).run({ history: user("work") });
    expect(result.status).toBe("limit_reached");
  });

  it("lets a productive run finish past the base limit", async () => {
    const llm = scriptedLLM([...stepCalls(5), { text: "all done" }]);
    const logs: string[] = [];
    const engine = new AgentEngine({ llm: llm.client, tools: registry(), ...base, dynamicBudget: { extensionTurns: 3, maxExtensions: 1, window: 2 }, logger: (m) => logs.push(m) });
    const result = await engine.run({ history: user("work") });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("all done");
    expect(result.toolCalls).toHaveLength(5);
    expect(logs).toContain("budget.extended");
  });

  it("never exceeds the extension ceiling", async () => {
    const llm = scriptedLLM([...stepCalls(30), { text: "wrapped up" }]);
    const engine = new AgentEngine({ llm: llm.client, tools: registry(), ...base, dynamicBudget: { extensionTurns: 3, maxExtensions: 1, window: 2 } });
    const result = await engine.run({ history: user("work") });
    expect(result.status).toBe("limit_reached");
    expect(result.toolCalls.length).toBe(6);
  });

  it("does not extend a failing run", async () => {
    const llm = scriptedLLM([...stepCalls(5), { text: "stopped" }]);
    const engine = new AgentEngine({
      llm: llm.client,
      tools: registry(() => {
        throw new Error("boom");
      }),
      ...base,
      dynamicBudget: { extensionTurns: 3, window: 2 },
    });
    const result = await engine.run({ history: user("work") });
    expect(result.status).toBe("limit_reached");
    expect(result.toolCalls).toHaveLength(3);
  });

  it("respects an explicit per-run tool-call cap", async () => {
    const llm = scriptedLLM([...stepCalls(5), { text: "stopped" }]);
    const engine = new AgentEngine({ llm: llm.client, tools: registry(), ...base, dynamicBudget: { extensionTurns: 3, window: 2 } });
    const result = await engine.run({ history: user("work"), maxToolCalls: 3 });
    expect(result.status).toBe("limit_reached");
    expect(result.toolCalls.length).toBe(3);
  });

  it("extends a tool-call budget hit when the run is still productive", async () => {
    const llm = scriptedLLM([...stepCalls(6), { text: "done" }]);
    const engine = new AgentEngine({
      llm: llm.client,
      tools: registry(),
      maxTurns: 20,
      maxToolIterations: 20,
      maxToolCalls: 3,
      dynamicBudget: { extensionTurns: 6, maxExtensions: 2, window: 2 },
    });
    const result = await engine.run({ history: user("work") });
    expect(result.status).toBe("completed");
  });
});
