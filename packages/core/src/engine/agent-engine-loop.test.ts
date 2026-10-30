import { AgentEngine } from "./agent-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { RUN_SUMMARY_SENTINEL, pruneToolResults, splitUnits } from "./context-manager.js";
import { scriptedLLM } from "./__tests__/scripted-llm.js";
import type { EngineEvent, EngineLLMClient, EngineMessage, EngineTool } from "./types.js";
import { MetricsCollector } from "../metrics-collector.js";

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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function reply(text: string | null, calls?: Array<{ name: string; args?: unknown; id: string }>) {
  return {
    choices: [
      {
        message: {
          role: "assistant" as const,
          content: text,
          ...(calls
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                })),
              }
            : {}),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

describe("steering during tool execution", () => {
  it("skips tool calls that have not started when a new message arrives", async () => {
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondExecute = jest.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry();
    registry.registerAll([
      tool({
        name: "first_action",
        risk: "config_write",
        approval: "auto",
        async execute() { firstStarted(); await gate; return { ok: true }; },
      }),
      tool({ name: "second_action", risk: "config_write", approval: "auto", execute: secondExecute }),
    ]);
    const llm = scriptedLLM([
      { calls: [
        { name: "first_action", args: {}, id: "call_first" },
        { name: "second_action", args: {}, id: "call_second" },
      ] },
      { text: "I will follow the new instruction." },
    ]);
    const engine = new AgentEngine({ llm: llm.client, tools: registry });
    let runId = "";
    const running = engine.run({ history: user("Run both actions"), onEvent: (event) => { if (event.type === "run.started") runId = event.runId; } });
    await started;
    expect(engine.steer(runId, { text: "Do not run the second action", messageId: "steer-tool-message" })).toBe(true);
    releaseFirst();

    const result = await running;
    expect(result.status).toBe("completed");
    expect(secondExecute).not.toHaveBeenCalled();
    expect(result.toolCalls.map((call) => call.status)).toEqual(["succeeded", "blocked"]);
    expect(result.toolCalls[1].error).toContain("repeat this operation if needed");
    expect(llm.requests[1].messages.some((message) => message.role === "user" && String(message.content).includes("Do not run the second action"))).toBe(true);
  });
});

describe("parallel tool execution", () => {
  function parallelSetup(parallelSafe: boolean) {
    let running = 0;
    let peak = 0;
    const make = (name: string, delay: number) =>
      tool({
        name,
        parallelSafe,
        execute: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await sleep(delay);
          running -= 1;
          return { done: name };
        },
      });
    const registry = new ToolRegistry();
    registry.registerAll([make("slow", 60), make("fast", 5)]);
    const llm = scriptedLLM([
      {
        calls: [
          { name: "slow", args: { n: 1 }, id: "call_slow" },
          { name: "fast", args: { n: 2 }, id: "call_fast" },
        ],
      },
      { text: "ok" },
    ]);
    const engine = new AgentEngine({ llm: llm.client, tools: registry });
    return { engine, llm, getPeak: () => peak };
  }

  it("runs independent parallelSafe read calls concurrently and keeps result order", async () => {
    const { engine, llm, getPeak } = parallelSetup(true);
    const result = await engine.run({ history: user("go") });
    expect(result.status).toBe("completed");
    expect(getPeak()).toBe(2);
    const toolMessages = llm.requests[1].messages.filter((message) => message.role === "tool");
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(["call_slow", "call_fast"]);
    expect(result.toolCalls.map((call) => call.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("keeps calls sequential unless the tool opted in", async () => {
    const { engine, getPeak } = parallelSetup(false);
    const result = await engine.run({ history: user("go") });
    expect(result.status).toBe("completed");
    expect(getPeak()).toBe(1);
  });

  it("never runs write tools concurrently and honours the tool-call budget", async () => {
    let running = 0;
    let peak = 0;
    const writer = tool({
      name: "writer",
      risk: "config_write",
      approval: "auto",
      parallelSafe: true,
      execute: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(15);
        running -= 1;
        return { ok: true };
      },
    });
    const registry = new ToolRegistry();
    registry.register(writer);
    const llm = scriptedLLM([
      {
        calls: [
          { name: "writer", args: { n: 1 }, id: "w1" },
          { name: "writer", args: { n: 2 }, id: "w2" },
          { name: "writer", args: { n: 3 }, id: "w3" },
        ],
      },
      { text: "wrapped up" },
    ]);
    const engine = new AgentEngine({ llm: llm.client, tools: registry, maxToolCalls: 2 });
    const result = await engine.run({ history: user("go") });
    expect(peak).toBe(1);
    expect(result.toolCalls.filter((call) => call.status === "succeeded")).toHaveLength(2);
    expect(result.toolCalls.filter((call) => call.status === "blocked")).toHaveLength(1);
    expect(result.status).toBe("limit_reached");
  });
});

describe("repeatSafe polling tools", () => {
  const pollScript = (name: string, times: number) => [
    ...Array.from({ length: times }, (_, i) => ({ calls: [{ name, args: { process_id: "p1" }, id: `poll_${i}` }] })),
    { text: "finished" },
  ];

  it("never blocks identical repeatSafe calls and does not flag a loop", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "poll", repeatSafe: true }));
    const llm = scriptedLLM(pollScript("poll", 10));
    const engine = new AgentEngine({ llm: llm.client, tools: registry });
    const result = await engine.run({ history: user("wait for the build") });
    expect(result.status).toBe("completed");
    expect(result.toolCalls).toHaveLength(10);
    expect(result.toolCalls.every((call) => call.status === "succeeded")).toBe(true);
    expect(result.toolCalls.some((call) => call.status === "blocked")).toBe(false);
  });

  it("does not spend the tool-call budget on repeatSafe calls", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "poll", repeatSafe: true }));
    const llm = scriptedLLM(pollScript("poll", 10));
    const engine = new AgentEngine({ llm: llm.client, tools: registry, maxToolCalls: 5 });
    const result = await engine.run({ history: user("wait for the build") });
    expect(result.status).toBe("completed");
    expect(result.toolCalls.filter((call) => call.status === "succeeded")).toHaveLength(10);
    expect(result.toolCalls.some((call) => call.error?.includes("budget"))).toBe(false);
  });

  it("keeps blocking identical calls of tools that are not repeatSafe", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "plain" }));
    const llm = scriptedLLM(pollScript("plain", 4));
    const engine = new AgentEngine({ llm: llm.client, tools: registry });
    const result = await engine.run({ history: user("repeat yourself") });
    expect(result.toolCalls.map((call) => call.status)).toEqual(["succeeded", "succeeded", "blocked", "blocked"]);
  });
});

describe("model failover", () => {
  it("switches to a fallback model when the primary request fails", async () => {
    const primary: EngineLLMClient = {
      model: "primary-model",
      async complete() {
        // Real provider errors carry the HTTP status; the engine classifies failures by it.
        throw Object.assign(new Error("503 upstream unavailable"), { status: 503 });
      },
    };
    const backup = scriptedLLM([{ text: "answered by backup" }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary),
      tools: new ToolRegistry(),
      fallbackModels: ["backup"],
    });
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("hi"), onEvent: (event) => events.push(event) });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("answered by backup");
    expect(result.model).toBe("backup-model");
    const fallback = events.find((event) => event.type === "model.fallback");
    expect(fallback).toMatchObject({ from: "primary-model", to: "backup-model" });
  });

  it("does not retry or fall back for an invalid API key", async () => {
    const primary: EngineLLMClient = {
      model: "primary-model",
      async complete() {
        throw Object.assign(new Error("Invalid API key"), { status: 401 });
      },
    };
    const backup = scriptedLLM([{ text: "must not run" }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary),
      tools: new ToolRegistry(),
      fallbackModels: ["backup"],
    });

    const result = await engine.run({ history: user("hi") });

    expect(result.status).toBe("failed");
    expect(result.error?.toLowerCase()).toContain("invalid api key");
    expect(backup.requests).toHaveLength(0);
  });

  it("fails clearly when every fallback also fails", async () => {
    const broken = (name: string): EngineLLMClient => ({
      model: name,
      async complete() {
        throw Object.assign(new Error(`${name} down`), { status: 503 });
      },
    });
    const engine = new AgentEngine({
      llm: (model?: string) => broken(model ?? "primary-model"),
      tools: new ToolRegistry(),
      fallbackModels: ["b1", "b2"],
    });
    const result = await engine.run({ history: user("hi") });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("b2 down");
  });

  it("does not fail over on user cancellation", async () => {
    const controller = new AbortController();
    const primary: EngineLLMClient = {
      model: "primary-model",
      async complete() {
        controller.abort();
        throw new Error("aborted");
      },
    };
    const backup = scriptedLLM([{ text: "should not run" }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary),
      tools: new ToolRegistry(),
      fallbackModels: ["backup"],
    });
    const result = await engine.run({ history: user("hi"), signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(backup.requests).toHaveLength(0);
  });
});

describe("run wall-clock budget", () => {
  it("turns a model call that outlives the deadline into a limit result", async () => {
    const llm: EngineLLMClient = {
      model: "slow-model",
      async complete(_messages, options) {
        return await new Promise<never>((_resolve, reject) => {
          if (options?.signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const engine = new AgentEngine({ llm, tools: new ToolRegistry(), maxWallTimeMs: 25 });

    const result = await engine.run({ history: user("do not hang") });

    expect(result.status).toBe("limit_reached");
    expect(result.error).toBe("Run wall-time budget of 25 ms reached.");
    expect(result.finalText).toBe("");
  });

  it("emits a structured budget event and records the terminal outcome", async () => {
    const llm = scriptedLLM([{ text: "done" }]);
    const metrics = new MetricsCollector();
    const events: EngineEvent[] = [];
    const engine = new AgentEngine({ llm: llm.client, tools: new ToolRegistry(), metrics });

    const result = await engine.run({ history: user("measure me"), onEvent: (event) => events.push(event) });

    const budget = events.find((event) => event.type === "run.budget");
    expect(budget).toMatchObject({ runId: result.runId, wallTimeMs: 0, outcome: "completed" });
    expect(budget && budget.type === "run.budget" ? budget.elapsedMs : -1).toBeGreaterThanOrEqual(0);
    expect(metrics.getCounter("agent_runs_total", { outcome: "completed" })).toBe(1);
    expect(metrics.getStats("latency_agent_run")?.count).toBe(1);
  });

  it("cancels an in-flight tool when the wall-time deadline expires", async () => {
    let resolveStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const registry = new ToolRegistry();
    registry.register(tool({
      name: "hang",
      execute: (_input, context) => new Promise<never>((_resolve, reject) => {
        resolveStarted();
        context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    }));
    const llm = scriptedLLM([{ calls: [{ name: "hang", id: "hang-1" }] }]);
    const engine = new AgentEngine({ llm: llm.client, tools: registry, maxWallTimeMs: 30 });
    const running = engine.run({ history: user("stop the tool") });
    await toolStarted;
    const result = await running;
    expect(result.status).toBe("limit_reached");
    expect(result.toolCalls[0].status).toBe("cancelled");
  });

  it("cancels an in-flight required-risk tool when the wall-time deadline expires", async () => {
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => { toolStarted = resolve; });
    const registry = new ToolRegistry();
    registry.register(tool({
      name: "write",
      risk: "config_write",
      approval: "required",
      execute: (_input, context) => new Promise((_resolve, reject) => {
        toolStarted();
        context.signal.addEventListener("abort", () => reject(new Error("tool cancelled")), { once: true });
      }),
    }));
    const llm = scriptedLLM([{ calls: [{ name: "write", id: "write-1" }] }]);
    const engine = new AgentEngine({ llm: llm.client, tools: registry, maxWallTimeMs: 100 });

    const running = engine.run({ history: user("approve the write") });
    await started;
    const result = await running;
    expect(result.status).toBe("limit_reached");
    expect(result.toolCalls[0].status).toBe("cancelled");
  });
});

describe("in-run context compaction", () => {
  it("summarises old agent steps, hands the summary to the host and keeps working", async () => {
    const big = "x".repeat(1_800);
    const registry = new ToolRegistry();
    registry.register(tool({ name: "dump", execute: () => ({ blob: big }) }));

    let agentTurn = 0;
    const seen: EngineMessage[][] = [];
    const llm: EngineLLMClient = {
      model: "test-model",
      async complete(messages, options) {
        const first = messages[0];
        if (typeof first?.content === "string" && first.content.includes("compress the working history")) {
          return reply("SUMMARY: inspected files a, b and c; found the config path /etc/app.conf");
        }
        // The completion check after a final answer is not an agent turn; answer it without recording it.
        if (options?.json === true) return reply(JSON.stringify({ needs_tool_execution: false }));
        seen.push(structuredClone(messages));
        agentTurn += 1;
        if (agentTurn <= 6 && options?.tools?.length) {
          return reply(null, [{ name: "dump", args: { n: agentTurn }, id: `call_${agentTurn}` }]);
        }
        return reply("All done.");
      },
    };

    const compacted: Array<{ summary: string; goal: string; droppedMessages: number }> = [];
    const engine = new AgentEngine({
      llm,
      tools: registry,
      contextWindowTokens: 1_500,
      compaction: { triggerRatio: 0.5, keepRecentUnits: 2, keepRecentToolResults: 1 },
      onContextCompact: (info) => {
        compacted.push({ summary: info.summary, goal: info.goal, droppedMessages: info.droppedMessages });
      },
    });
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("audit the project"), onEvent: (event) => events.push(event) });

    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("All done.");
    expect(compacted.length).toBeGreaterThanOrEqual(1);
    expect(compacted[0].summary).toContain("/etc/app.conf");
    expect(compacted[0].goal).toBe("audit the project");
    expect(events.some((event) => event.type === "context.compacted")).toBe(true);

    const last = seen[seen.length - 1];
    const note = last.find((message) => typeof message.content === "string" && message.content.startsWith(RUN_SUMMARY_SENTINEL));
    expect(note).toBeDefined();
    // The user's request must survive compaction, and no tool message may be orphaned.
    expect(last.some((message) => message.role === "user" && message.content === "audit the project")).toBe(true);
    const callIds = new Set(last.flatMap((message) => (message.tool_calls ?? []).map((call) => call.id)));
    for (const message of last.filter((m) => m.role === "tool")) expect(callIds.has(message.tool_call_id ?? "")).toBe(true);
  });

  it("falls back to plain trimming when the summary cannot be produced", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "dump", execute: () => ({ blob: "y".repeat(1_800) }) }));
    let agentTurn = 0;
    const llm: EngineLLMClient = {
      model: "test-model",
      async complete(messages, options) {
        const first = messages[0];
        if (typeof first?.content === "string" && first.content.includes("compress the working history")) {
          throw new Error("summariser unavailable");
        }
        agentTurn += 1;
        if (agentTurn <= 5 && options?.tools?.length) {
          return reply(null, [{ name: "dump", args: { n: agentTurn }, id: `c${agentTurn}` }]);
        }
        return reply("finished anyway");
      },
    };
    const engine = new AgentEngine({
      llm,
      tools: registry,
      contextWindowTokens: 1_500,
      compaction: { triggerRatio: 0.5, keepRecentUnits: 2, keepRecentToolResults: 1 },
    });
    const result = await engine.run({ history: user("keep going") });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("finished anyway");
  });

  it("is disabled with compaction:false", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "dump", execute: () => ({ blob: "z".repeat(1_800) }) }));
    const onContextCompact = jest.fn();
    let agentTurn = 0;
    const llm: EngineLLMClient = {
      model: "test-model",
      async complete(_messages, options) {
        agentTurn += 1;
        if (agentTurn <= 4 && options?.tools?.length) {
          return reply(null, [{ name: "dump", args: { n: agentTurn }, id: `d${agentTurn}` }]);
        }
        return reply("done");
      },
    };
    const engine = new AgentEngine({ llm, tools: registry, contextWindowTokens: 1_500, compaction: false, onContextCompact });
    const result = await engine.run({ history: user("go") });
    expect(result.status).toBe("completed");
    expect(onContextCompact).not.toHaveBeenCalled();
  });
});

describe("context-manager helpers", () => {
  const toolMsg = (name: string, content: string, id: string): EngineMessage => ({ role: "tool", name, content, tool_call_id: id });

  it("prunes only old, large tool results and keeps the newest verbatim", () => {
    const messages: EngineMessage[] = [
      { role: "user", content: "task" },
      toolMsg("a", "A".repeat(900), "1"),
      toolMsg("b", "short", "2"),
      toolMsg("c", "C".repeat(900), "3"),
      toolMsg("d", "D".repeat(900), "4"),
    ];
    const pruned = pruneToolResults(messages, { keepRecentToolResults: 2, minCharsToPrune: 400 });
    expect(pruned[1].content).toContain("[tool result pruned: a, 900 chars");
    expect(pruned[2].content).toBe("short");
    expect(pruned[3].content).toBe("C".repeat(900));
    expect(pruned[4].content).toBe("D".repeat(900));
    // The input is never mutated: the full text stays in the run state.
    expect(messages[1].content).toBe("A".repeat(900));
    expect(pruneToolResults(messages, { keepRecentToolResults: 10 })).toBe(messages);
  });

  it("splits a conversation so tool results stay glued to their assistant call", () => {
    const messages: EngineMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "a", arguments: "{}" } }] },
      toolMsg("a", "r1", "1"),
      { role: "assistant", content: "done" },
    ];
    const units = splitUnits(messages);
    expect(units.map((unit) => unit.map((message) => message.role))).toEqual([
      ["user"],
      ["assistant", "tool"],
      ["assistant"],
    ]);
  });
});

describe("contextProvider", () => {
  it("receives the user's request and session so memory can be recalled semantically", async () => {
    const seen: Array<{ runId: string; sessionId?: string; goal: string; toolsEnabled: boolean }> = [];
    const llm = scriptedLLM([{ text: "ok" }]);
    const registry = new ToolRegistry();
    registry.register(tool({ name: "noop" }));
    const engine = new AgentEngine({
      llm: llm.client,
      tools: registry,
      contextProvider: (info) => {
        seen.push(info);
        return "RECALLED: the project codename is Falcon";
      },
    });
    const result = await engine.run({ runId: "run-ctx", sessionId: "chat-9", history: user("what is my codename?") });
    expect(result.status).toBe("completed");
    expect(seen).toEqual([{ runId: "run-ctx", sessionId: "chat-9", goal: "what is my codename?", toolsEnabled: true }]);
    const system = llm.requests[0].messages.find((message) => message.role === "system");
    expect(String(system?.content)).toContain("RECALLED: the project codename is Falcon");
  });
});

describe("run pipeline improvements", () => {
  it("still recalls memory when the run has tools disabled", async () => {
    const seen: boolean[] = [];
    const llm = scriptedLLM([{ text: "ok" }]);
    const registry = new ToolRegistry();
    registry.register(tool({ name: "noop" }));
    const engine = new AgentEngine({
      llm: llm.client,
      tools: registry,
      contextProvider: (info) => {
        seen.push(info.toolsEnabled);
        return "RECALLED: owner prefers Bengali";
      },
    });
    const result = await engine.run({ history: user("hello"), allowTools: false });
    expect(result.status).toBe("completed");
    expect(seen).toEqual([false]);
    const system = llm.requests[0].messages.find((message) => message.role === "system");
    expect(String(system?.content)).toContain("RECALLED: owner prefers Bengali");
  });

  it("retries once in the same run when the first model reply is empty", async () => {
    const llm = scriptedLLM([{ text: "" }, { text: "Here is the answer." }]);
    const engine = new AgentEngine({ llm: llm.client, tools: new ToolRegistry() });
    const result = await engine.run({ history: user("question") });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("Here is the answer.");
    expect(llm.requests).toHaveLength(2);
  });

  it("fails only after the empty-reply retry is also empty", async () => {
    const llm = scriptedLLM([{ text: "" }]);
    const engine = new AgentEngine({ llm: llm.client, tools: new ToolRegistry() });
    const result = await engine.run({ history: user("question") });
    expect(result.status).toBe("failed");
    expect(llm.requests).toHaveLength(2);
  });

  it("tells the model what a tool expects when the arguments are invalid", async () => {
    const registry = new ToolRegistry();
    registry.register(
      tool({
        name: "search",
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "integer" } },
          required: ["query"],
          additionalProperties: false,
        },
      }),
    );
    const llm = scriptedLLM([{ calls: [{ name: "search", args: {} }] }, { text: "done" }]);
    const engine = new AgentEngine({ llm: llm.client, tools: registry });
    await engine.run({ history: user("find it") });
    const toolMessage = llm.requests[1].messages.find((message) => message.role === "tool");
    expect(String(toolMessage?.content)).toContain("Missing required argument");
    expect(String(toolMessage?.content)).toContain("query (string, required), limit (integer)");
  });
});

describe("model-judged interruption of running tools", () => {
  // The tool finishes after 50 ms unless its signal is aborted, so a test never waits on a gate.
  const runWithSteer = async (judge: jest.Mock<Promise<boolean>, [unknown]>) => {
    let started!: () => void;
    const startedSignal = new Promise<void>((resolve) => { started = resolve; });
    const registry = new ToolRegistry();
    registry.registerAll([
      tool({
        name: "long_action",
        risk: "config_write",
        approval: "auto",
        async execute(_args, context) {
          started();
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 50);
            context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
          });
          return { ok: true };
        },
      }),
    ]);
    const llm = scriptedLLM([
      { calls: [{ name: "long_action", args: {}, id: "call_long" }] },
      { text: "Adjusted." },
    ]);
    const engine = new AgentEngine({ llm: llm.client, tools: registry, steerToolInterrupt: judge as never });
    let runId = "";
    const running = engine.run({
      history: user("Start the long action"),
      onEvent: (event) => { if (event.type === "run.started") runId = event.runId; },
    });
    await startedSignal;
    expect(engine.steer(runId, { text: "Use the other file instead" })).toBe(true);
    return running;
  };

  it("stops only the running tool when the model judges the new message changes it", async () => {
    const judge = jest.fn<Promise<boolean>, [unknown]>(async () => true);
    const result = await runWithSteer(judge);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0][0]).toMatchObject({ steerText: "Use the other file instead", runningTools: [{ name: "long_action" }] });
    expect(result.toolCalls[0].status).toBe("cancelled");
    expect(result.toolCalls[0].error).toContain("A new message from the user changed this step");
  });

  it("lets the running tool finish when the model judges the message can wait", async () => {
    const judge = jest.fn<Promise<boolean>, [unknown]>(async () => false);
    const result = await runWithSteer(judge);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(result.toolCalls[0].status).toBe("succeeded");
  });

  it("leaves the tool running when the judgement itself fails", async () => {
    const judge = jest.fn<Promise<boolean>, [unknown]>(async () => { throw new Error("judge unavailable"); });
    const result = await runWithSteer(judge);
    expect(result.toolCalls[0].status).toBe("succeeded");
  });
});

describe("steering does not abort a completion that is already writing", () => {
  it("lets the draft finish by default and reads the new message on the next turn", async () => {
    const requests: Array<{ messages: any[]; options: any }> = [];
    let runId = "";
    let steer: (text: string) => boolean = () => false;
    const llm = {
      model: "steer-default-model",
      async complete(messages: any[], options: any = {}) {
        requests.push({ messages, options });
        if (requests.length === 1) {
          steer("Use the other file instead");
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { choices: [{ message: { role: "assistant", content: "First draft." } }], usage: { total_tokens: 3 } };
        }
        return { choices: [{ message: { role: "assistant", content: "Adjusted." } }], usage: { total_tokens: 3 } };
      },
    };
    const engine = new AgentEngine({ llm: llm as never, tools: new ToolRegistry() });
    steer = (text) => engine.steer(runId, { text });
    const result = await engine.run({
      history: user("Start"),
      onEvent: (event) => { if (event.type === "run.started") runId = event.runId; },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(false);
    expect(result.finalText).toBe("Adjusted.");
    expect(String(requests[1].messages.find((m) => m.role === "user" && String(m.content).includes("New messages from the user"))?.content)).toContain("Use the other file instead");
  });
});
