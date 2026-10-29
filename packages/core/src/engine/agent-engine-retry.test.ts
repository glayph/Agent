import { AgentEngine } from "./agent-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { scriptedLLM } from "./__tests__/scripted-llm.js";
import type { EngineEvent, EngineLLMClient, EngineMessage, EngineTool } from "./types.js";

const user = (content: string): EngineMessage[] => [{ role: "user", content }];
const unavailable = () => Object.assign(new Error("Service unavailable"), { status: 503 });
const fast = { baseDelayMs: 5, maxDelayMs: 10 };

function reply(text: string | null, calls?: Array<{ name: string; id: string }>) {
  return {
    choices: [{
      message: {
        role: "assistant" as const,
        content: text,
        ...(calls ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: "{}" } })) } : {}),
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** A model that fails with 503 for the listed call numbers (1-based) and otherwise returns the next scripted reply. */
function flaky(failOnCalls: number[], replies: Array<ReturnType<typeof reply>>) {
  let calls = 0;
  let next = 0;
  const client: EngineLLMClient = {
    model: "flaky-model",
    async complete() {
      calls += 1;
      if (failOnCalls.includes(calls)) throw unavailable();
      return replies[Math.min(next++, replies.length - 1)] as never;
    },
  };
  return { client, calls: () => calls };
}

describe("in-place retry of transient model failures", () => {
  it("fails the run when retryTransient is not requested (previous behaviour)", async () => {
    const llm = flaky([1], [reply("ok")]);
    const engine = new AgentEngine({ llm: llm.client, tools: new ToolRegistry() });
    const result = await engine.run({ history: user("hi") });
    expect(result.status).toBe("failed");
    expect(llm.calls()).toBe(1);
  });

  it("waits and retries the same call until the model answers", async () => {
    const llm = flaky([1, 2, 3], [reply("back online")]);
    const engine = new AgentEngine({ llm: llm.client, tools: new ToolRegistry() });
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("hi"), retryTransient: fast, onEvent: (event) => events.push(event) });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("back online");
    expect(llm.calls()).toBe(4);
    const retrying = events.filter((event) => event.type === "model.retrying");
    expect(retrying).toHaveLength(3);
    expect(retrying.map((event) => (event as { retry: number }).retry)).toEqual([1, 2, 3]);
    expect(Math.max(...retrying.map((event) => (event as { delayMs: number }).delayMs))).toBeLessThanOrEqual(10);
    expect(events.filter((event) => event.type === "model.resumed")).toEqual([expect.objectContaining({ retries: 3 })]);
  });

  it("resumes after a tool call at the failed step without re-running the tool", async () => {
    let executed = 0;
    const registry = new ToolRegistry();
    const probe: EngineTool = {
      name: "probe",
      description: "probe",
      risk: "read",
      parameters: { type: "object", properties: {}, additionalProperties: true },
      execute: () => { executed += 1; return { ok: true }; },
    };
    registry.register(probe);
    // Call 1: asks for the tool. Calls 2 and 3: outage. Call 4: final answer.
    const llm = flaky([2, 3], [reply(null, [{ name: "probe", id: "c1" }]), reply("done after outage")]);
    const engine = new AgentEngine({ llm: llm.client, tools: registry });
    const result = await engine.run({ history: user("use the tool"), retryTransient: fast });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("done after outage");
    expect(executed).toBe(1);
  });

  it("does not retry a permanent failure such as an invalid API key", async () => {
    let calls = 0;
    const client: EngineLLMClient = {
      model: "m",
      async complete() { calls += 1; throw Object.assign(new Error("Invalid API key"), { status: 401 }); },
    };
    const engine = new AgentEngine({ llm: client, tools: new ToolRegistry() });
    const result = await engine.run({ history: user("hi"), retryTransient: fast });
    expect(result.status).toBe("failed");
    expect(calls).toBe(1);
  });

  it("stops waiting as soon as the run is cancelled", async () => {
    const client: EngineLLMClient = { model: "m", async complete() { throw unavailable(); } };
    const engine = new AgentEngine({ llm: client, tools: new ToolRegistry() });
    const controller = new AbortController();
    const started = Date.now();
    const run = engine.run({
      history: user("hi"),
      retryTransient: { baseDelayMs: 60_000, maxDelayMs: 60_000 },
      signal: controller.signal,
      onEvent: (event) => { if (event.type === "model.retrying") setTimeout(() => controller.abort(), 20); },
    });
    const result = await run;
    expect(result.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("model failover versus waiting for the primary model", () => {
  const probeTool = (onRun: () => void): EngineTool => ({
    name: "probe",
    description: "probe",
    risk: "read",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: () => { onRun(); return { ok: true }; },
  });

  it("a run with disableModelFallback waits for its own model and never uses the fallback", async () => {
    const primary = flaky([1, 2], [reply("answered by the primary")]);
    const backup = scriptedLLM([{ text: "answered by the weak fallback" }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary.client),
      tools: new ToolRegistry(),
      fallbackModels: ["backup"],
    });
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("hi"), retryTransient: fast, disableModelFallback: true, onEvent: (event) => events.push(event) });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("answered by the primary");
    expect(result.model).toBe("flaky-model");
    expect(backup.requests).toHaveLength(0);
    expect(events.some((event) => event.type === "model.fallback")).toBe(false);
    expect(events.filter((event) => event.type === "model.retrying")).toHaveLength(2);
    expect(events.filter((event) => event.type === "model.resumed")).toHaveLength(1);
  });

  it("still fails over for an ordinary run (interactive behaviour is unchanged)", async () => {
    const primary = flaky([1], [reply("answered by the primary")]);
    const backup = scriptedLLM([{ text: "answered by backup" }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary.client),
      tools: new ToolRegistry(),
      fallbackModels: ["backup"],
    });
    const result = await engine.run({ history: user("hi"), retryTransient: fast });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("answered by backup");
  });

  it("disableModelFallback without retryTransient fails the run instead of switching models", async () => {
    const primary = flaky([1], [reply("never reached")]);
    const backup = scriptedLLM([{ text: "must not run" }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary.client),
      tools: new ToolRegistry(),
      fallbackModels: ["backup"],
    });
    const result = await engine.run({ history: user("hi"), disableModelFallback: true });
    expect(result.status).toBe("failed");
    expect(backup.requests).toHaveLength(0);
  });

  it("a failover lasts one turn: the next turn is answered by the primary model again", async () => {
    let executed = 0;
    const registry = new ToolRegistry();
    registry.register(probeTool(() => { executed += 1; }));
    // Primary fails on its first call only; after that it is healthy again.
    const primary = flaky([1], [reply("answered by the primary again")]);
    const backup = scriptedLLM([{ calls: [{ name: "probe", id: "c1" }] }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary.client),
      tools: registry,
      fallbackModels: ["backup"],
    });
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("use the tool"), onEvent: (event) => events.push(event) });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("answered by the primary again");
    expect(result.model).toBe("flaky-model");
    expect(executed).toBe(1);
    // The backup answered exactly once (turn 1); every later request, including the completion check, went to the primary.
    expect(backup.requests).toHaveLength(1);
    expect(primary.calls()).toBeGreaterThanOrEqual(2);
    expect(events.filter((event) => event.type === "model.fallback")).toHaveLength(1);
  });

  it("tries the primary first on every turn, even while it is still down", async () => {
    const registry = new ToolRegistry();
    registry.register(probeTool(() => undefined));
    const primary = flaky([1, 2], [reply("unused")]);
    const backup = scriptedLLM([{ calls: [{ name: "probe", id: "c1" }] }, { text: "backup finished" }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary.client),
      tools: registry,
      fallbackModels: ["backup"],
    });
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("use the tool"), onEvent: (event) => events.push(event) });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("backup finished");
    // Turn 1 and turn 2 each started on the primary model and each failed over once.
    expect(primary.calls()).toBe(2);
    expect(events.filter((event) => event.type === "model.fallback")).toHaveLength(2);
  });
});
