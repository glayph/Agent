import { AgentEngine } from "./agent-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { ApprovalStore } from "./approval-store.js";
import { scriptedLLM } from "./__tests__/scripted-llm.js";
import type { EngineEvent, EngineTool } from "./types.js";

function tool(overrides: Partial<EngineTool> & { name: string }): EngineTool {
  return {
    description: overrides.name,
    risk: "read",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: () => ({ ok: true }),
    ...overrides,
  };
}

function setup(replies: Parameters<typeof scriptedLLM>[0], tools: EngineTool[], extra = {}) {
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  const llm = scriptedLLM(replies);
  const engine = new AgentEngine({ llm: llm.client, tools: registry, ...extra });
  return { engine, llm, registry };
}

const user = (content: string) => [{ role: "user" as const, content }];

describe("AgentEngine", () => {
  it("answers a plain message in one turn without planning", async () => {
    const { engine, llm } = setup([{ text: "Hello!" }], [tool({ name: "ping" })]);
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("hi"), onEvent: (e) => events.push(e) });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("Hello!");
    expect(result.turns).toBe(1);
    expect(result.plan).toBeUndefined();
    expect(result.usage.totalTokens).toBe(15);
    expect(llm.requests).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "turn.started",
      "message.final",
      "run.finished",
    ]);
  });

  it("forwards streamed text as message.delta events before the final answer", async () => {
    const llm = {
      model: "stream-model",
      async complete(_messages: unknown, options: { onTextDelta?: (delta: string) => void } = {}) {
        for (const part of ["Hel", "lo ", "there"]) options.onTextDelta?.(part);
        return { choices: [{ message: { role: "assistant", content: "Hello there" } }], usage: { total_tokens: 4 } };
      },
    };
    const engine = new AgentEngine({ llm: llm as never, tools: new ToolRegistry() });
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("hi"), onEvent: (e) => events.push(e) });
    expect(result.finalText).toBe("Hello there");
    const deltas = events.filter((e) => e.type === "message.delta").map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(["Hel", "lo ", "there"]);
    const types = events.map((e) => e.type);
    expect(types.indexOf("message.delta")).toBeLessThan(types.indexOf("message.final"));
  });

  it("runs a multi-step tool loop and feeds results back to the model", async () => {
    const readFile = jest.fn(async (input: Record<string, unknown>) => ({ content: `data:${input.path}` }));
    const { engine, llm } = setup(
      [
        { calls: [{ name: "read_it", args: { path: "a.txt" } }], text: "Reading a" },
        { calls: [{ name: "read_it", args: { path: "b.txt" } }] },
        { text: "Both files read." },
      ],
      [
        tool({
          name: "read_it",
          parameters: {
            type: "object",
            required: ["path"],
            properties: { path: { type: "string" } },
          },
          execute: readFile,
        }),
      ],
    );
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("hello"), onEvent: (e) => events.push(e) });

    expect(result.status).toBe("completed");
    expect(result.turns).toBe(3);
    expect(result.toolCalls.map((c) => c.status)).toEqual(["succeeded", "succeeded"]);
    expect(readFile).toHaveBeenCalledTimes(2);

    // The tool result must be visible to the model on the next turn.
    const lastRequest = llm.requests[2].messages;
    const toolMessages = lastRequest.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0].content).toContain("data:a.txt");
    expect(events.some((e) => e.type === "thought")).toBe(true);
    const statuses = events
      .filter((e): e is Extract<EngineEvent, { type: "tool.call" }> => e.type === "tool.call")
      .map((e) => e.call.status);
    expect(statuses).toEqual(["requested", "running", "succeeded", "requested", "running", "succeeded"]);
  });

  it("settles an LLM-created plan when the run completes", async () => {
    const { engine } = setup(
      [
        { text: JSON.stringify({ steps: [{ title: "Read the file", tool: "ping" }, { title: "Summarize", tool: null }] }) },
        { calls: [{ name: "ping" }] },
        { text: "done" },
      ],
      [tool({ name: "ping" })],
    );
    const events: EngineEvent[] = [];
    const history = user("First read the config file and then summarize it, then check the setting");
    const plan = await engine.plan("First read the config file and then summarize it, then check the setting");
    const result = await engine.run({
      history,
      plan,
      onEvent: (e) => events.push(e),
    });
    expect(result.plan?.source).toBe("llm");
    expect(result.plan?.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(events.filter((e) => e.type === "plan.created")).toHaveLength(1);
  });

  it("returns an error to the model for invalid JSON, unknown tools and bad arguments", async () => {
    const { engine, llm } = setup(
      [
        {
          calls: [
            { name: "needs_path", rawArgs: "{not json" },
            { name: "does_not_exist" },
            { name: "needs_path", args: {} },
          ],
        },
        { text: "recovered" },
      ],
      [
        tool({
          name: "needs_path",
          parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
        }),
      ],
    );
    const result = await engine.run({ history: user("hi") });
    expect(result.status).toBe("completed");
    expect(result.toolCalls.map((c) => c.status)).toEqual(["failed", "failed", "failed"]);
    const toolMessages = llm.requests[1].messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0].content).toContain("Invalid JSON");
    expect(toolMessages[1].content).toContain("Unknown tool");
    expect(toolMessages[2].content).toContain("Missing required argument");
    expect(toolMessages[2].content).toContain("path");
  });

  it("denies risky tools without an approval gate and never executes them", async () => {
    const execute = jest.fn();
    const { engine } = setup(
      [{ calls: [{ name: "danger" }] }, { text: "I could not do that." }],
      [tool({ name: "danger", risk: "destructive", execute })],
    );
    const result = await engine.run({ history: user("hi") });
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolCalls[0].status).toBe("denied");
    expect(result.status).toBe("completed");
  });

  it("waits for approval, then executes the approved call", async () => {
    const approvals = new ApprovalStore();
    const execute = jest.fn(async () => ({ written: true }));
    const { engine } = setup(
      [{ calls: [{ name: "write_it", args: { v: 1 } }] }, { text: "written" }],
      [tool({ name: "write_it", risk: "config_write", execute, parameters: { type: "object", properties: { v: { type: "number" } } } })],
      { approvals },
    );
    const events: EngineEvent[] = [];
    const running = engine.run({ history: user("hi"), onEvent: (e) => events.push(e) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = approvals.list({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    approvals.approve(pending[0].id);
    const result = await running;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.toolCalls[0].status).toBe("succeeded");
    expect(result.toolCalls[0].approvalId).toBe(pending[0].id);
    expect(
      events.some((e) => e.type === "tool.call" && e.call.status === "awaiting_approval"),
    ).toBe(true);
  });

  it("reports a denied approval to the model", async () => {
    const approvals = new ApprovalStore();
    const execute = jest.fn();
    const { engine, llm } = setup(
      [{ calls: [{ name: "write_it" }] }, { text: "ok, not doing it" }],
      [tool({ name: "write_it", risk: "config_write", execute })],
      { approvals },
    );
    const running = engine.run({ history: user("hi") });
    await new Promise((resolve) => setTimeout(resolve, 20));
    approvals.deny(approvals.list()[0].id, "tester", "no thanks");
    const result = await running;
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolCalls[0].status).toBe("denied");
    const toolMessage = llm.requests[1].messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("did not approve");
  });

  it("blocks identical repeated calls and stops a stuck loop with a wrap-up answer", async () => {
    const execute = jest.fn(() => ({ same: true }));
    const { engine } = setup(
      [
        (messages) =>
          messages.some((m) => m.content?.toString().includes("Without calling any tools"))
            ? { text: "I was looping; here is what I know." }
            : { calls: [{ name: "spin", args: { a: 1 } }] },
      ],
      [tool({ name: "spin", execute, parameters: { type: "object", properties: { a: { type: "number" } } } })],
      { maxTurns: 10 },
    );
    const result = await engine.run({ history: user("hi") });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("limit_reached");
    expect(result.error).toContain("loop");
    expect(result.finalText).toContain("looping");
    expect(result.toolCalls.filter((c) => c.status === "blocked").length).toBeGreaterThanOrEqual(3);
  });

  it("enforces the turn limit and still produces a final answer", async () => {
    let n = 0;
    const { engine } = setup(
      [
        (messages) =>
          messages.some((m) => m.content?.toString().includes("Without calling any tools"))
            ? { text: "Summary of partial work." }
            : { calls: [{ name: "step", args: { n: n++ } }] },
      ],
      [tool({ name: "step", parameters: { type: "object", properties: { n: { type: "number" } } } })],
      { maxTurns: 3 },
    );
    const result = await engine.run({ history: user("hi") });
    expect(result.status).toBe("limit_reached");
    expect(result.turns).toBe(3);
    expect(result.finalText).toBe("Summary of partial work.");
  });

  it("resolves max tool iterations dynamically from the runtime setting", async () => {
    let limit = 2;
    const { engine, llm } = setup(
      [
        { calls: [{ name: "step", args: { n: 1 } }] },
        { calls: [{ name: "step", args: { n: 2 } }] },
        { text: "wrapped" },
      ],
      [tool({ name: "step" })],
      { maxTurns: () => limit },
    );
    const result = await engine.run({ history: user("do the task") });
    expect(result.status).toBe("limit_reached");
    expect(result.turns).toBe(2);
    expect(llm.requests).toHaveLength(3);
    limit = 5;
  });


  it("does not send tool schemas when they alone exceed the configured context window", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "huge",
      description: "x".repeat(20_000),
      risk: "read",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    });
    const requests: Array<{ options: Record<string, unknown> }> = [];
    const llm = {
      model: "test",
      complete: async (_messages: EngineMessage[], options: Record<string, unknown> = {}) => {
        requests.push({ options });
        if (requests.length === 1) {
          return { choices: [{ message: { content: "done" } }], usage: {} };
        }
        throw new Error("unexpected request");
      },
    };
    const engine = new AgentEngine({ llm, tools: registry, contextWindowTokens: 1024 });
    const result = await engine.run({ history: [{ role: "user", content: "task" }] });
    expect(result.status).toBe("completed");
    expect(requests[0].options.tools).toBeUndefined();
  });
  it("enforces context window before every model request, including tool loops", async () => {
    const { engine, llm } = setup(
      [
        { calls: [{ name: "grow" }] },
        { calls: [{ name: "grow" }] },
        { text: "done" },
      ],
      [tool({ name: "grow", execute: () => ({ payload: "X".repeat(900) }) })],
      { contextWindowTokens: 512 },
    );
    const result = await engine.run({
      history: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new task" },
      ],
    });
    expect(result.status).toBe("completed");
    for (const request of llm.requests) {
      expect(request.messages.some((message) => message.content === "old question")).toBe(false);
      expect(request.messages.some((message) => String(message.content || "").length >= 900)).toBe(false);
    }
  });

  it("never invents answer text when the wrap-up call fails", async () => {
    let calls = 0;
    const { engine } = setup(
      [
        () => {
          calls += 1;
          return calls <= 2 ? { calls: [{ name: "step", args: { n: calls } }] } : { error: "provider down" };
        },
      ],
      [tool({ name: "step", parameters: { type: "object", properties: { n: { type: "number" } } } })],
      { maxTurns: 2 },
    );
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("hi"), onEvent: (e) => events.push(e) });
    expect(result.status).toBe("limit_reached");
    expect(result.finalText).toBe("");
    expect(result.error).toContain("Step limit");
    expect(events.some((e) => e.type === "message.final")).toBe(false);
  });

  it("answers every tool call when the tool budget is exhausted mid-turn", async () => {
    const { engine, llm } = setup(
      [
        { calls: [{ name: "a", args: { i: 1 } }, { name: "a", args: { i: 2 } }, { name: "a", args: { i: 3 } }] },
        { text: "wrapped up" },
      ],
      [tool({ name: "a", parameters: { type: "object", properties: { i: { type: "number" } } } })],
      { maxToolCalls: 2 },
    );
    const result = await engine.run({ history: user("hi") });
    expect(result.status).toBe("limit_reached");
    const toolMessages = llm.requests[1].messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(result.toolCalls.map((c) => c.status)).toEqual(["succeeded", "succeeded", "blocked"]);
  });

  it("times out a hanging tool and lets the model continue", async () => {
    const { engine } = setup(
      [{ calls: [{ name: "hang" }] }, { text: "tool timed out, sorry" }],
      [tool({ name: "hang", execute: () => new Promise(() => undefined) })],
      { toolTimeoutMs: 30 },
    );
    const result = await engine.run({ history: user("hi") });
    expect(result.toolCalls[0].status).toBe("failed");
    expect(result.toolCalls[0].error).toContain("timed out");
    expect(result.status).toBe("completed");
  });

  it("cancels a run while a tool is executing", async () => {
    const controller = new AbortController();
    const { engine } = setup(
      [{ calls: [{ name: "hang" }] }, { text: "never reached" }],
      [tool({ name: "hang", execute: () => new Promise(() => undefined) })],
    );
    const running = engine.run({ history: user("hi"), signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.toolCalls[0].status).toBe("cancelled");
  });

  it("cancels while waiting for approval and marks the approval denied", async () => {
    const approvals = new ApprovalStore();
    const controller = new AbortController();
    const { engine } = setup(
      [{ calls: [{ name: "write_it" }] }],
      [tool({ name: "write_it", risk: "config_write" })],
      { approvals },
    );
    const running = engine.run({ history: user("hi"), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(approvals.list()[0].status).toBe("denied");
  });

  it("fails clearly when no model is configured", async () => {
    const registry = new ToolRegistry();
    const engine = new AgentEngine({ llm: () => undefined, tools: registry });
    const result = await engine.run({ history: user("hi") });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("No model is configured");
  });

  it("surfaces provider errors as a failed run", async () => {
    const { engine } = setup([{ error: "429 rate limited" }], []);
    const result = await engine.run({ history: user("hi") });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("429");
  });

  it("redacts credential-shaped strings in tool output before the model sees them", async () => {
    const { engine, llm } = setup(
      [{ calls: [{ name: "leak" }] }, { text: "done" }],
      [tool({ name: "leak", execute: () => ({ key: "sk-abcdefghijklmnopqrstuvwxyz123456" }) })],
    );
    await engine.run({ history: user("hi") });
    const toolMessage = llm.requests[1].messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("[REDACTED]");
    expect(toolMessage?.content).not.toContain("sk-abcdefghijkl");
  });

  it("clears duplicate counters after a state-changing tool succeeds", async () => {
    const read = jest.fn(() => ({ v: 1 }));
    const write = jest.fn(() => ({ ok: true }));
    const { engine } = setup(
      [
        { calls: [{ name: "read" }] },
        { calls: [{ name: "read" }] },
        { calls: [{ name: "write" }] },
        { calls: [{ name: "read" }] },
        { text: "done" },
      ],
      [tool({ name: "read", execute: read }), tool({ name: "write", risk: "config_write", approval: "auto", execute: write })],
    );
    const result = await engine.run({ history: user("hi") });
    expect(result.status).toBe("completed");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("runs without tools when allowTools is false", async () => {
    const { engine, llm } = setup([{ text: "plain" }], [tool({ name: "ping" })]);
    const result = await engine.run({ history: user("hi"), allowTools: false });
    expect(result.status).toBe("completed");
    expect(llm.requests[0].options?.tools).toBeUndefined();
  });
});
