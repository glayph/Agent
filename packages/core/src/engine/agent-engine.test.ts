import { AgentEngine } from "./agent-engine.js";
import { ToolRegistry } from "./tool-registry.js";
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
    expect(result.usage.totalTokens).toBe(27);
    expect(llm.requests).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "turn.started",
      "message.final",
      "run.budget",
      "run.finished",
    ]);
  });

  it("turns a plan-only operational reply into real tool execution", async () => {
    const execute = jest.fn(async () => ({ ok: true, path: "docs/demo_test.txt" }));
    const { engine, llm } = setup(
      [
        { text: "First I will call file_write, then I will verify the result." },
        { calls: [{ name: "file_write", args: { path: "docs/demo_test.txt", content: "demo" } }] },
        { text: "Done — the file was written and verified." },
      ],
      [tool({
        name: "file_write",
        execute,
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      })],
    );
    const result = await engine.run({ history: user("Show me a real example: write a file and verify it") });
    expect(result.status).toBe("completed");
    expect(result.finalText).toContain("written");
    expect(execute).toHaveBeenCalledTimes(1);
    // Draft, completion check, nudged tool call, tool result turn. The completion check runs only once per run.
    expect(llm.requests).toHaveLength(4);
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
    // Text written next to tool calls was addressed to the user: it is marked so it is kept, not retracted.
    const thoughts = events.filter((e): e is Extract<EngineEvent, { type: "thought" }> => e.type === "thought");
    expect(thoughts).toEqual([expect.objectContaining({ turn: 1, content: "Reading a", interim: true })]);
    const statuses = events
      .filter((e): e is Extract<EngineEvent, { type: "tool.call" }> => e.type === "tool.call")
      .map((e) => e.call.status);
    expect(statuses).toEqual(["requested", "running", "succeeded", "requested", "running", "succeeded"]);
  });

  it("generates a user-facing task understanding before executing a tool-first action", async () => {
    const order: string[] = [];
    const execute = jest.fn(async () => {
      order.push("tool");
      return { ok: true };
    });
    const { engine, llm } = setup(
      [
        { calls: [{ name: "create_account" }] },
        { text: "I understand you want an account created; I will complete the signup steps and verify the result." },
        { text: "The signup process is complete." },
      ],
      [tool({ name: "create_account", execute })],
    );
    const events: EngineEvent[] = [];
    const result = await engine.run({
      history: user("Create an account and confirm whether signup succeeds."),
      preActionUpdates: true,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "thought" && event.interim) order.push("notice");
      },
    });

    expect(result.status).toBe("completed");
    expect(order).toEqual(["notice", "tool"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "thought",
      interim: true,
      content: expect.stringContaining("account created"),
    }));
    const noticeRequest = llm.requests.find((request) => request.options?.toolChoice === "none");
    expect(noticeRequest?.messages.at(-1)?.content).toContain("Before the first action");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("interrupts an in-flight model completion and discards its stale answer", async () => {
    let steer: (text: string) => boolean = () => false;
    const { engine } = setup(
      [
        async () => { steer("one more thing"); return { text: "Stale answer." }; },
        { text: "Second answer." },
      ],
      [],
      { steerInterrupt: true },
    );
    const events: EngineEvent[] = [];
    let runId = "";
    steer = (text) => engine.steer(runId, text);
    const result = await engine.run({
      history: user("hello"),
      onEvent: (e) => { runId = e.runId; events.push(e); },
    });

    expect(result.finalText).toBe("Second answer.");
    expect(events.filter((e) => e.type === "model.steer_interrupt")).toHaveLength(1);
    expect(events.filter((e) => e.type === "thought")).toHaveLength(0);
    expect(events.filter((e) => e.type === "model.retrying" || e.type === "model.fallback")).toHaveLength(0);
    expect(events.filter((e) => e.type === "message.final")).toHaveLength(1);
  });

  it("aborts only the current model call when a new message arrives and does not count it as a retry", async () => {
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const requests: Array<{ messages: any[]; options: any }> = [];
    const llm = {
      model: "steer-test-model",
      async complete(messages: any[], options: any = {}) {
        requests.push({ messages, options });
        if (requests.length === 1) {
          return await new Promise<any>((_resolve, reject) => {
            options.onTextDelta?.("partial draft");
            options.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
            startedResolve();
          });
        }
        return { choices: [{ message: { role: "assistant", content: "Updated answer." } }], usage: { total_tokens: 5 } };
      },
    };
    const engine = new AgentEngine({ llm: llm as never, tools: new ToolRegistry(), steerInterrupt: true });
    const events: EngineEvent[] = [];
    const running = engine.run({ runId: "steer-run", history: user("Original request"), onEvent: (event) => events.push(event) });
    await started;
    expect(engine.steer("steer-run", { text: "Use the updated requirement", messageId: "steer-message" })).toBe(true);

    const result = await running;
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("Updated answer.");
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);
    expect(requests[1].messages.some((message) => message.role === "user" && String(message.content).includes("Use the updated requirement"))).toBe(true);
    expect(String(requests[1].messages.find((message) => message.role === "user" && String(message.content).includes("New messages from the user"))?.content)).toMatch(/1\. \[Received at \d{4}-/);
    expect(events.some((event) => event.type === "thought" && event.content === "partial draft")).toBe(true);
    expect(events.filter((event) => event.type === "model.retrying" || event.type === "model.fallback")).toHaveLength(0);
  });

  it("keeps steering non-interrupting when steerInterrupt is disabled", async () => {
    let startedResolve!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const requests: Array<{ messages: any[]; options: any }> = [];
    const llm = {
      model: "steer-opt-out-model",
      async complete(messages: any[], options: any = {}) {
        requests.push({ messages, options });
        if (requests.length === 1) {
          startedResolve();
          await firstGate;
          return { choices: [{ message: { role: "assistant", content: "Stale draft." } }] };
        }
        return { choices: [{ message: { role: "assistant", content: "Updated answer." } }], usage: { total_tokens: 5 } };
      },
    };
    const engine = new AgentEngine({ llm: llm as never, tools: new ToolRegistry(), steerInterrupt: false });
    const events: EngineEvent[] = [];
    const running = engine.run({ runId: "steer-opt-out-run", history: user("Original request"), onEvent: (event) => events.push(event) });
    await started;
    expect(engine.steer("steer-opt-out-run", { text: "Use the updated requirement" })).toBe(true);
    expect(requests[0].options.signal.aborted).toBe(false);
    releaseFirst();

    const result = await running;
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("Updated answer.");
    expect(requests[0].options.signal.aborted).toBe(false);
    expect(requests[1].messages.some((message) => message.role === "user" && String(message.content).includes("Use the updated requirement"))).toBe(true);
    expect(events.some((event) => event.type === "thought" && event.content === "Stale draft." && event.interim === true)).toBe(true);
    expect(events.filter((event) => event.type === "model.steer_interrupt")).toHaveLength(0);
  });

  it("keeps user Stop separate from a steering interrupt", async () => {
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const stop = new AbortController();
    const llm = {
      model: "stop-test-model",
      async complete(_messages: any[], options: any = {}) {
        return await new Promise<any>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
          startedResolve();
        });
      },
    };
    const engine = new AgentEngine({ llm: llm as never, tools: new ToolRegistry() });
    const running = engine.run({ runId: "stop-run", history: user("Original request"), signal: stop.signal });
    await started;
    stop.abort();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("Run cancelled.");
  });

  it("hands the images and message ids of a steered message to the model and the event stream", async () => {
    let runId = "";
    let engineRef: AgentEngine | undefined;
    const { engine, llm } = setup(
      [
        async () => {
          engineRef!.steer(runId, { text: "use this style", imageUrls: ["data:image/png;base64,AAAA", ""], messageId: "m1" });
          engineRef!.steer(runId, { text: "", imageUrls: ["data:image/png;base64,BBBB"], messageId: "m2" });
          return { text: "First answer." };
        },
        { text: "Second answer." },
      ],
      [],
    );
    engineRef = engine;
    const events: EngineEvent[] = [];
    await engine.run({ history: user("hello"), onEvent: (e) => { runId = e.runId; events.push(e); } });

    const steered = llm.requests.flatMap((request) => request.messages).find((message) => message.role === "user" && String(message.content).includes("New messages from the user"));
    expect(steered?.image_urls).toEqual(["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]);
    expect(String(steered?.content)).toContain("use this style");
    expect(events.find((e) => e.type === "user.steer")).toEqual(expect.objectContaining({ count: 2, messageIds: ["m1", "m2"] }));
  });

  it("rejects a steered message with neither text nor images", () => {
    const { engine } = setup([{ text: "ok" }], []);
    expect(engine.steer("no-such-run", { text: "hi" })).toBe(false);
  });

  it("tells the model not to repeat a reply the user already got for a queued message", async () => {
    let runId = "";
    let engineRef: AgentEngine | undefined;
    let acknowledged = false;
    const { engine, llm } = setup(
      [
        async () => {
          engineRef!.steer(runId, { text: "also rename the file", messageId: "m1" });
          acknowledged = engineRef!.noteSteerAcknowledged(runId, "m1", "Got it, I will rename it after this step.");
          return { text: "First answer." };
        },
        { text: "Second answer." },
      ],
      [],
    );
    engineRef = engine;
    await engine.run({ history: user("hello"), onEvent: (e) => { runId = e.runId; } });

    expect(acknowledged).toBe(true);
    const steered = llm.requests.flatMap((request) => request.messages).find((message) => String(message.content).includes("New messages from the user"));
    expect(String(steered?.content)).toContain("You already told the user: \"Got it, I will rename it after this step.\"");
    // Once the run has read the message it can no longer be acknowledged.
    expect(engine.noteSteerAcknowledged(runId, "m1", "late")).toBe(false);
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

  it("executes risky tools without an interactive approval pause in autonomous mode", async () => {
    const execute = jest.fn(async () => ({ deleted: true }));
    const { engine } = setup(
      [{ calls: [{ name: "danger" }] }, { text: "Completed the requested operation." }],
      [tool({ name: "danger", risk: "destructive", execute, approval: "required" })],
    );
    const result = await engine.run({ history: user("hi") });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.toolCalls[0].status).toBe("succeeded");
    expect(result.toolCalls[0].approvalId).toBeUndefined();
  });

  it("still enforces an explicit policy block without creating an approval request", async () => {
    const execute = jest.fn();
    const { engine, llm } = setup(
      [{ calls: [{ name: "write_it" }] }, { text: "The policy blocked that operation." }],
      [tool({ name: "write_it", risk: "config_write", execute })],
    );
    const result = await engine.run({ history: user("hi"), approvalPolicy: { decide: () => ({ mode: "block", reason: "policy denied" }) } });
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolCalls[0].status).toBe("blocked");
    expect(llm.requests[1].messages.find((message) => message.role === "tool")?.content).toContain("policy denied");
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

  it("enforces a cumulative token budget before executing additional tools", async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const { engine, llm } = setup(
      [
        { calls: [{ name: "step", args: { n: 1 } }] },
        { calls: [{ name: "step", args: { n: 2 } }] },
      ],
      [tool({ name: "step", execute, parameters: { type: "object", properties: { n: { type: "number" } } } })],
    );
    const result = await engine.run({ history: user("do bounded work"), maxTotalTokens: 20, maxCompletionTokens: 10 });
    expect(result.status).toBe("limit_reached");
    expect(result.error).toContain("Total-token budget");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1].options?.maxCompletionTokens).toBe(5);
  });

  it("estimates usage when a provider omits token metadata so budget enforcement stays active", async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const llm = {
      model: "usage-less-provider",
      async complete() {
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "step", arguments: "{}" } }] } }] };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool({ name: "step", execute }));
    const guarded = new AgentEngine({ llm: llm as never, tools: registry });
    const result = await guarded.run({ history: user("do not exceed budget"), maxTotalTokens: 1 });
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.status).toBe("limit_reached");
    expect(execute).not.toHaveBeenCalled();
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
        if (options.json === true) {
          return { choices: [{ message: { content: JSON.stringify({ needs_tool_execution: false }) } }], usage: {} };
        }
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
      // The system prompt is itself longer than 900 chars; the assertion is about tool payloads.
      expect(request.messages.some((message) => message.role !== "system" && String(message.content || "").length >= 900)).toBe(false);
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

  it("cancels a running tool when the user stops the autonomous run", async () => {
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => { started = resolve; });
    const controller = new AbortController();
    const execute = jest.fn((_input: unknown, context: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      started();
      context.signal.addEventListener("abort", () => reject(new Error("tool cancelled")), { once: true });
    }));
    const { engine } = setup([{ calls: [{ name: "write_it" }] }], [tool({ name: "write_it", risk: "config_write", execute, approval: "required" })]);
    const running = engine.run({ history: user("hi"), signal: controller.signal });
    await toolStarted;
    controller.abort();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.toolCalls[0].status).toBe("cancelled");
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

  describe("long-running tools and system notices", () => {
    it("a tool can opt out of the engine's per-call timeout (timeoutMs: 0)", async () => {
      const slow = tool({
        name: "slow",
        timeoutMs: 0,
        execute: (_input, ctx) =>
          new Promise((resolve, reject) => {
            ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            setTimeout(() => resolve({ done: true }), 150);
          }),
      });
      const { engine } = setup([{ calls: [{ name: "slow" }] }, { text: "ok" }], [slow], { toolTimeoutMs: 40 });
      const result = await engine.run({ history: user("go") });
      expect(result.toolCalls[0].status).toBe("succeeded");
      expect(result.finalText).toBe("ok");
    });

    it("a tool without an override is still stopped by the default tool timeout", async () => {
      const slow = tool({
        name: "slow",
        execute: (_input, ctx) =>
          new Promise((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
      });
      const { engine } = setup([{ calls: [{ name: "slow" }] }, { text: "gave up" }], [slow], { toolTimeoutMs: 40 });
      const result = await engine.run({ history: user("go") });
      expect(result.toolCalls[0].status).toBe("failed");
    });

    it("delivers host notices to the model at the start of the next turn", async () => {
      const notices = [[], ["Command proc_1 finished successfully (exit code 0)."]];
      let call = 0;
      const { engine, llm } = setup([{ calls: [{ name: "ping" }] }, { text: "noted" }], [tool({ name: "ping" })], {
        notifications: () => notices[Math.min(call++, notices.length - 1)],
      });
      const events: EngineEvent[] = [];
      await engine.run({ history: user("start a build"), onEvent: (e) => events.push(e) });
      const second = llm.requests[1].messages;
      const last = second[second.length - 1];
      expect(last.role).toBe("user");
      expect(last.content).toContain("[system notice]");
      expect(last.content).toContain("proc_1 finished successfully");
      expect(llm.requests[0].messages.some((m) => String(m.content).includes("[system notice]"))).toBe(false);
      expect(events.some((e) => e.type === "system.notice")).toBe(true);
    });

    it("a failing notifications hook never breaks the run", async () => {
      const { engine } = setup([{ text: "fine" }], [tool({ name: "ping" })], {
        notifications: () => {
          throw new Error("boom");
        },
      });
      const result = await engine.run({ history: user("hi") });
      expect(result.status).toBe("completed");
    });
  });
});
