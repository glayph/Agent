import { AgentEngine } from "./agent-engine.js";
import { ApprovalStore } from "./approval-store.js";
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

describe("model failover", () => {
  it("switches to a fallback model when the primary request fails", async () => {
    const primary: EngineLLMClient = {
      model: "primary-model",
      async complete() {
        throw new Error("503 upstream unavailable");
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

  it("fails clearly when every fallback also fails", async () => {
    const broken = (name: string): EngineLLMClient => ({
      model: name,
      async complete() {
        throw new Error(`${name} down`);
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

  it("cancels an approval wait when the wall-time deadline expires", async () => {
    const approvals = new ApprovalStore();
    const registry = new ToolRegistry();
    registry.register(tool({ name: "write", risk: "config_write" }));
    const llm = scriptedLLM([{ calls: [{ name: "write", id: "write-1" }] }]);
    const engine = new AgentEngine({ llm: llm.client, tools: registry, approvals, maxWallTimeMs: 30 });

    const result = await engine.run({ history: user("approve the write") });

    expect(result.status).toBe("limit_reached");
    expect(result.toolCalls[0].status).toBe("cancelled");
    expect(approvals.list()[0].status).toBe("denied");
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
