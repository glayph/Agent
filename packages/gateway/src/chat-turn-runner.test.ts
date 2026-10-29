import Database from "better-sqlite3";
import type { WebSocket } from "ws";
import { createChatTurnRunner, type ChatTurnInput } from "./chat-turn-runner.js";
import { ProviderRequestError } from "./provider-error.js";
import { StreamHub } from "./stream-hub.js";

class FakeSocket {
  readyState = 1;
  OPEN = 1;
  sent: Array<Record<string, any>> = [];
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  get types() {
    return this.sent.map((message) => message.type);
  }
}
const asSocket = (socket: FakeSocket) => socket as unknown as WebSocket;

type StartRun = (input: any) => Promise<any>;

const SESSION = "s1";
const CONTEXT = "channel:default-channel:peer:s1";

function createHarness(startRun: StartRun, options: { retryDelayMs?: (retryIndex: number) => number; recallLearningFeedback?: (question: string) => string | undefined; recallLearnedGuidance?: () => string | undefined; chooseLearnedModel?: (question: string) => string | undefined; detectFollowUpFeedback?: (input: any) => Promise<void>; steerRun?: (runId: string, input: { text: string; imageUrls?: string[]; messageId?: string }) => boolean; llmComplete?: (messages: any[], options?: any) => Promise<any>; noteSteerAcknowledged?: (runId: string, messageId: string, reply: string) => boolean; quickReplyAfterMs?: number } = {}) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal', model_name TEXT, context_id TEXT, image_urls TEXT, attachments_json TEXT, reply_to_message_id TEXT, status TEXT NOT NULL DEFAULT 'completed', status_detail TEXT);
  `);
  const stamp = () => new Date().toISOString();
  db.prepare("INSERT INTO chat_sessions(id,title,created_at,updated_at) VALUES(?,?,?,?)").run(SESSION, "Miki chat", stamp(), stamp());

  const hub = new StreamHub({ sweepIntervalMs: 0 });
  const logs: string[] = [];
  const emitted: Array<{ event: string; payload: any }> = [];
  const agentCalls: any[] = [];
  const runner = createChatTurnRunner({
    db,
    streamHub: hub,
    agent: {
      llmFor: () => ({ model: "fake-model", ...(options.llmComplete ? { complete: options.llmComplete } : {}) }),
      startRun: (input) => {
        agentCalls.push(input);
        return startRun(input);
      },
      cancelRun: () => undefined,
      steerRun: options.steerRun,
      noteSteerAcknowledged: options.noteSteerAcknowledged,
    },
    fileMemory: {
      updateConfig: () => undefined,
      compaction: { compact: async () => ({ compacted: false, messages: [], archivedCount: 0 }) },
    } as any,
    getAppConfig: () => ({}),
    now: stamp,
    log: (message) => logs.push(message),
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/data",
    // The real mapper turns engine events into UI events; here it only forwards the final answer.
    createWsEventMapper: ((emit: (type: string, payload: unknown) => void, _model?: string, _tf?: unknown, _mc?: unknown, _ac?: unknown, onInterimMessage?: (message: { id: string; content: string }) => void, onSteeredMessagesRead?: (messageIds: string[], runId: string) => void) => ({
      finalIds: [] as string[],
      finalId: `final-${Math.random().toString(36).slice(2)}`,
      attachments: () => [],
      handle: (event: { type?: string; content?: string; runId?: string; interim?: boolean; messageIds?: string[] }) => {
        if (event.type === "user.steer" && event.messageIds?.length) onSteeredMessagesRead?.(event.messageIds, event.runId ?? "");
        if (event.type === "message.final") emit("message.final", { content: event.content });
        if (event.type === "thought" && event.interim && event.content) onInterimMessage?.({ id: `interim-${Math.random().toString(36).slice(2)}`, content: event.content });
      },
    })) as any,
    planAdaptiveOutput: ((message: { id: string; content: string }) => [{ id: message.id, content: message.content }]) as any,
    getLifecycleBus: (() => ({ emit: (event: string, payload: unknown) => emitted.push({ event, payload }) })) as any,
    retrieveRelevantTurns: (() => []) as any,
    resolveContextWindowTokens: (() => 8192) as any,
    // Retries wait instantly unless a test asks for a specific schedule.
    retryDelayMs: options.retryDelayMs ?? (() => 0),
    quickReplyAfterMs: options.quickReplyAfterMs,
    recallLearningFeedback: options.recallLearningFeedback,
    recallLearnedGuidance: options.recallLearnedGuidance,
    chooseLearnedModel: options.chooseLearnedModel,
    detectFollowUpFeedback: options.detectFollowUpFeedback,
  });

  const send = (content: string, extra: Partial<ChatTurnInput> = {}, clientMessageId?: string) => {
    const replies: Array<{ type: string; payload: any }> = [];
    const promise = runner.run({
      sessionId: SESSION,
      contextId: CONTEXT,
      peerId: SESSION,
      reply: (type, payload) => replies.push({ type, payload }),
      trigger: { type: "user", mode: "send", content, attachments: [], clientMessageId },
      ...extra,
    });
    return { promise, replies };
  };
  const messages = () => db.prepare("SELECT id,role,content,kind,status,status_detail FROM chat_messages ORDER BY rowid").all() as Array<Record<string, any>>;
  return { db, hub, runner, send, messages, logs, emitted, agentCalls };
}

const answer = (text: string): StartRun => async (input) => {
  input.onEvent({ type: "message.final", runId: input.runId, content: text });
  input.onEvent({ type: "run.finished" });
  return { status: "completed", finalText: text, toolCalls: [], model: "fake-model" };
};

describe("ChatTurnRunner", () => {
  it("runs a turn with no socket: saves the answer and keeps the stream for a later subscriber", async () => {
    // Phase 0 goal: a turn no longer needs a browser connection.
    const h = createHarness(answer("hello back"));
    const { promise } = h.send("hello", { socket: null }, "m1");
    const outcome = await promise;

    expect(outcome.status).toBe("completed");
    expect(h.messages().map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "hello", "completed"],
      ["assistant", "hello back", "completed"],
    ]);

    const run = h.hub.get(outcome.runId!)!;
    expect(run.subscribers.size).toBe(0);
    expect(run.done).toBe(true);
    const buffered = run.events.map((raw) => JSON.parse(raw).type);
    expect(buffered).toContain("message.final");
    expect(buffered[buffered.length - 1]).toBe("stream_done");

    const late = new FakeSocket();
    h.hub.resume(run, asSocket(late), 0);
    expect(late.types).toEqual(buffered);
  });

  it("streams to the given socket and tells the requester the message was accepted first", async () => {
    const h = createHarness(answer("ok"));
    const socket = new FakeSocket();
    const { promise, replies } = h.send("hi", { socket: asSocket(socket) }, "m1");
    const outcome = await promise;

    expect(replies[0]).toMatchObject({ type: "message.accepted", payload: { message_id: "m1", client_message_id: "m1", status: "queued", queue_position: 0 } });
    expect(socket.types[0]).toBe("stream_checkpoint");
    expect(socket.types).toContain("message.status");
    expect(socket.types[socket.types.length - 1]).toBe("stream_done");
    expect(socket.sent[socket.sent.length - 1].payload).toMatchObject({ status: "completed", run_id: outcome.runId });
    // processing -> completed on the user's own message
    const statuses = socket.sent.filter((m) => m.type === "message.status").map((m) => m.payload.status);
    expect(statuses).toEqual(["processing", "completed"]);
  });

  it("announces the finished reply on the lifecycle bus", async () => {
    const h = createHarness(answer("done"));
    await h.send("hi").promise;
    expect(h.emitted).toEqual([{ event: "message:sent", payload: expect.objectContaining({ session_key: CONTEXT, text: "done", status: "completed" }) }]);
  });

  it("titles a fresh chat after the first message it receives", async () => {
    const h = createHarness(answer("ok"));
    await h.send("Build me a landing page for my bakery").promise;
    const title = (h.db.prepare("SELECT title FROM chat_sessions WHERE id=?").get(SESSION) as { title: string }).title;
    expect(title).not.toBe("Miki chat");
    expect(title.toLowerCase()).toContain("landing page");
  });

  it("serializes turns of one conversation and builds the second history after the first answer", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let call = 0;
    const h = createHarness(async (input) => {
      call += 1;
      const text = `reply ${call}`;
      if (call === 1) await gate;
      input.onEvent({ type: "message.final", runId: input.runId, content: text });
      return { status: "completed", finalText: text, toolCalls: [], model: "fake-model" };
    });

    const first = h.send("first");
    const second = h.send("second");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(h.agentCalls).toHaveLength(1);
    expect(second.replies[0].payload).toMatchObject({ status: "queued", queue_position: 0 });

    releaseFirst();
    await Promise.all([first.promise, second.promise]);

    expect(h.agentCalls).toHaveLength(2);
    // The second run starts only after the first one finishes and therefore sees its answer.
    const secondHistory = h.agentCalls[1].history.map((m: { role: string; content: string }) => `${m.role}:${m.content}`);
    expect(secondHistory.sort()).toEqual(["assistant:reply 1", "user:first", "user:second"]);
    expect(h.messages().map((m) => m.content).sort()).toEqual(["first", "reply 1", "reply 2", "second"]);
  });

  it("hands a message sent during a working run to that run instead of starting another", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const steered: Array<{ runId: string; text: string }> = [];
    const h = createHarness(async (input) => {
      await gate;
      input.onEvent({ type: "message.final", runId: input.runId, content: "done" });
      return { status: "completed", finalText: "done", toolCalls: [], model: "fake-model" };
    }, { steerRun: (runId, steerInput) => { steered.push({ runId, text: steerInput.text }); return true; } });

    const first = h.send("make 10 files");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = h.send("start them all with test-");
    const outcome = await second.promise;

    expect(outcome.status).toBe("steered");
    expect(steered).toEqual([{ runId: h.agentCalls[0].runId, text: "start them all with test-" }]);
    expect(h.agentCalls).toHaveLength(1);
    // Delivered, but the working run has not read it yet: it must not look finished.
    expect(h.messages().find((m) => m.content === "start them all with test-")?.status).toBe("processing");

    releaseFirst();
    await first.promise;
  });

  it("waits for a run that is still starting, then steers into it instead of starting another", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let refusals = 3; // the agent has not registered the run yet
    const steered: string[] = [];
    const h = createHarness(async (input) => {
      await gate;
      input.onEvent({ type: "message.final", runId: input.runId, content: "done" });
      return { status: "completed", finalText: "done", toolCalls: [], model: "fake-model" };
    }, { steerRun: (_runId, steerInput) => { if (refusals > 0) { refusals -= 1; return false; } steered.push(steerInput.text); return true; } });

    const first = h.send("make 10 files");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const outcome = await h.send("start them all with test-").promise;

    expect(outcome.status).toBe("steered");
    expect(steered).toEqual(["start them all with test-"]);
    expect(h.agentCalls).toHaveLength(1);

    releaseFirst();
    await first.promise;
  });

  it("passes the images sent with a mid-run message to the working run", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const steered: Array<{ text: string; imageUrls?: string[]; messageId?: string }> = [];
    const h = createHarness(async (input) => {
      await gate;
      input.onEvent({ type: "message.final", runId: input.runId, content: "done" });
      return { status: "completed", finalText: "done", toolCalls: [], model: "fake-model" };
    }, { steerRun: (_runId, steerInput) => { steered.push(steerInput); return true; } });

    const first = h.send("make a logo");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const image = "data:image/png;base64,AAAA";
    const withText = h.send("use this style", { trigger: { type: "user", mode: "send", content: "use this style", attachments: [{ type: "image", url: image }] } });
    const imageOnly = h.send("", { trigger: { type: "user", mode: "send", content: "", attachments: [{ type: "image", url: image }] } });
    expect((await withText.promise).status).toBe("steered");
    expect((await imageOnly.promise).status).toBe("steered");

    expect(steered.map((item) => [item.text, item.imageUrls])).toEqual([["use this style", [image]], ["", [image]]]);
    expect(steered.every((item) => typeof item.messageId === "string" && item.messageId.length > 0)).toBe(true);
    expect(h.agentCalls).toHaveLength(1);

    releaseFirst();
    await first.promise;
  });

  it("marks a mid-run message completed only when the working run reports it read it", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const steered: Array<{ messageId?: string }> = [];
    const h = createHarness(async (input) => {
      await gate;
      input.onEvent({ type: "message.final", runId: input.runId, content: "done" });
      return { status: "completed", finalText: "done", toolCalls: [], model: "fake-model" };
    }, { steerRun: (_runId, steerInput) => { steered.push(steerInput); return true; } });

    const first = h.send("long task");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.send("also do this").promise;
    const status = () => h.messages().find((m) => m.content === "also do this")?.status;
    expect(status()).toBe("processing");

    // The working run reads the message at the start of its next turn.
    h.agentCalls[0].onEvent({ type: "user.steer", runId: h.agentCalls[0].runId, turn: 2, count: 1, messageIds: [steered[0].messageId] });
    expect(status()).toBe("completed");

    releaseFirst();
    await first.promise;
    expect(status()).toBe("completed");
  });

  it("carries an unread steered message into exactly one new run after a failed run", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    const h = createHarness(async (input) => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return { status: "failed", finalText: "", error: "provider failed", toolCalls: [], model: "fake-model" };
      }
      input.onEvent({ type: "message.final", runId: input.runId, content: "Follow-up resumed." });
      return { status: "completed", finalText: "Follow-up resumed.", toolCalls: [], model: "fake-model" };
    }, { steerRun: () => true });

    const first = h.send("long task");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const followUp = h.send("follow-up instruction");
    expect((await followUp.promise).status).toBe("steered");
    releaseFirst();
    await first.promise;
    for (let i = 0; i < 100 && h.messages().find((m) => m.content === "follow-up instruction")?.status !== "completed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(calls).toBe(2);
    expect(h.messages().filter((message) => message.role === "user" && message.content === "follow-up instruction")).toHaveLength(1);
    expect(h.messages().find((message) => message.content === "follow-up instruction")?.status).toBe("completed");
    expect(h.agentCalls[1].history.some((message: { role: string; content: string }) => message.role === "user" && message.content === "follow-up instruction")).toBe(true);
  });

  it("does not carry unread messages over when the user explicitly stops the run", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    const h = createHarness(async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return { status: "failed", finalText: "", error: "provider down", toolCalls: [], model: "fake-model" };
      }
      return { status: "completed", finalText: "unexpected carryover", toolCalls: [], model: "fake-model" };
    }, { steerRun: () => true });

    const first = h.send("long task");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const followUp = h.send("do not lose this, but Stop should cancel carryover");
    expect((await followUp.promise).status).toBe("steered");
    const runId = h.agentCalls[0].runId as string;
    setTimeout(() => h.runner.cancelRetry(runId), 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseFirst();
    await first.promise;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(calls).toBe(1);
    expect(h.messages().find((message) => message.content === "do not lose this, but Stop should cancel carryover")?.status).toBe("cancelled");
  });

  it("carries a mid-run message into a new run when the working run ends without reading it", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    const h = createHarness(async (input) => {
      calls += 1;
      if (calls === 1) await gate;
      input.onEvent({ type: "message.final", runId: input.runId, content: "done" });
      return { status: "completed", finalText: "done", toolCalls: [], model: "fake-model" };
    }, { steerRun: () => true });

    const first = h.send("long task");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.send("one more thing").promise;
    releaseFirst();
    await first.promise;
    for (let i = 0; i < 100 && h.messages().find((m) => m.content === "one more thing")?.status !== "completed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(calls).toBe(2);
    expect(h.messages().find((m) => m.content === "one more thing")?.status).toBe("completed");
  });

  it("answers a mid-run message right away when the working run has not read it yet", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const completions: any[][] = [];
    const acknowledged: Array<{ messageId: string; reply: string }> = [];
    const h = createHarness(async (input) => {
      input.onEvent({ type: "tool.call", runId: input.runId, turn: 1, call: { id: "c1", name: "run_shell", status: "running" } });
      await gate;
      input.onEvent({ type: "message.final", runId: input.runId, content: "done" });
      return { status: "completed", finalText: "done", toolCalls: [], model: "fake-model" };
    }, {
      steerRun: () => true,
      quickReplyAfterMs: 20,
      llmComplete: async (messages) => { completions.push(messages); return { choices: [{ message: { content: "Got it, I will do that after this step." } }] }; },
      noteSteerAcknowledged: (_runId, messageId, reply) => { acknowledged.push({ messageId, reply }); return true; },
    });

    const first = h.send("run the long build");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.send("also tag the release").promise;
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(completions).toHaveLength(1);
    expect(completions[0][0].content).toContain('running the tool "run_shell"');
    expect(completions[0].at(-1)).toEqual({ role: "user", content: "also tag the release" });
    const userMessage = h.messages().find((m) => m.content === "also tag the release")!;
    expect(acknowledged).toEqual([{ messageId: userMessage.id, reply: "Got it, I will do that after this step." }]);
    const stored = h.messages().find((m) => m.content === "Got it, I will do that after this step.");
    expect(stored?.role).toBe("assistant");

    releaseFirst();
    await first.promise;
  });

  it("does not write an immediate reply when the working run reads the message in time", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const completions: any[][] = [];
    const steered: Array<{ messageId?: string }> = [];
    const h = createHarness(async (input) => {
      await gate;
      input.onEvent({ type: "message.final", runId: input.runId, content: "done" });
      return { status: "completed", finalText: "done", toolCalls: [], model: "fake-model" };
    }, {
      steerRun: (_runId, steerInput) => { steered.push(steerInput); return true; },
      quickReplyAfterMs: 40,
      llmComplete: async (messages) => { completions.push(messages); return { choices: [{ message: { content: "should not appear" } }] }; },
      noteSteerAcknowledged: () => true,
    });

    const first = h.send("task");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.send("quick follow-up").promise;
    h.agentCalls[0].onEvent({ type: "user.steer", runId: h.agentCalls[0].runId, turn: 2, count: 1, messageIds: [steered[0].messageId] });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(completions).toHaveLength(0);
    expect(h.messages().some((m) => m.content === "should not appear")).toBe(false);

    releaseFirst();
    await first.promise;
  });

  it("drops the immediate reply when the run read the message while the reply was being written", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const h = createHarness(async (input) => {
      await gate;
      input.onEvent({ type: "message.final", runId: input.runId, content: "done" });
      return { status: "completed", finalText: "done", toolCalls: [], model: "fake-model" };
    }, {
      steerRun: () => true,
      quickReplyAfterMs: 10,
      llmComplete: async () => ({ choices: [{ message: { content: "too late" } }] }),
      noteSteerAcknowledged: () => false, // the run already drained the message
    });

    const first = h.send("task");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.send("follow-up").promise;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(h.messages().some((m) => m.content === "too late")).toBe(false);

    releaseFirst();
    await first.promise;
  });

  it("writes no fixed fallback text when the model cannot write the immediate reply", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const h = createHarness(async (input) => {
      await gate;
      input.onEvent({ type: "message.final", runId: input.runId, content: "done" });
      return { status: "completed", finalText: "done", toolCalls: [], model: "fake-model" };
    }, {
      steerRun: () => true,
      quickReplyAfterMs: 10,
      llmComplete: async () => { throw new Error("provider down"); },
      noteSteerAcknowledged: () => true,
    });

    const first = h.send("task");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.send("follow-up").promise;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(h.messages().filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(h.logs.some((line) => line.includes("Immediate reply skipped"))).toBe(true);

    releaseFirst();
    await first.promise;
  });

  it("starts its own run when the working run ends before it can be steered", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const h = createHarness(async () => {
      await gate;
      return { status: "completed", finalText: "ok", toolCalls: [], model: "fake-model" };
    }, { steerRun: () => false });

    const first = h.send("one");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = h.send("two");
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseFirst();
    await first.promise;
    const outcome = await second.promise;

    expect(outcome.status).not.toBe("steered");
    expect(h.agentCalls).toHaveLength(2);
  });

  it("stores a message the agent wrote while working as its own message, before the final answer", async () => {
    const h = createHarness(async (input) => {
      input.onEvent({ type: "thought", runId: input.runId, turn: 1, content: "opening note", interim: true });
      input.onEvent({ type: "thought", runId: input.runId, turn: 2, content: "discarded draft" });
      input.onEvent({ type: "message.final", runId: input.runId, content: "the result" });
      input.onEvent({ type: "run.finished" });
      return { status: "completed", finalText: "the result", toolCalls: [], model: "fake-model" };
    });
    const { promise } = h.send("do the big job");
    await promise;

    expect(h.messages().map((m) => [m.role, m.content, m.kind])).toEqual([
      ["user", "do the big job", "normal"],
      ["assistant", "opening note", "normal"],
      ["assistant", "the result", "normal"],
    ]);
  });

  it("starts a new run again once the working run has finished", async () => {
    const h = createHarness(answer("ok"), { steerRun: () => true });
    await h.send("one").promise;
    const outcome = await h.send("two").promise;
    expect(outcome.status).not.toBe("steered");
    expect(h.agentCalls).toHaveLength(2);
  });

  it("does not make different conversations wait for each other", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let call = 0;
    const h = createHarness(async () => {
      call += 1;
      if (call === 1) await gate;
      return { status: "completed", finalText: "ok", toolCalls: [], model: "fake-model" };
    });

    const slow = h.send("slow");
    const other = h.send("other", { contextId: "channel:default-channel:peer:other" });
    const outcome = await other.promise;
    expect(outcome.status).toBe("completed");
    releaseFirst();
    await slow.promise;
  });

  it("saves a provider failure as an error message, marks the user message failed and ends the stream cleanly", async () => {
    const h = createHarness(async () => {
      throw new ProviderRequestError("Local model is unavailable.", "local_model_unavailable", "llama.cpp");
    });
    const socket = new FakeSocket();
    const outcome = await h.send("hi", { socket: asSocket(socket) }, "m1").promise;

    expect(outcome.status).toBe("failed");
    const rows = h.messages();
    expect(rows[0]).toMatchObject({ role: "user", status: "failed", status_detail: "Local model is unavailable." });
    expect(rows[1]).toMatchObject({ role: "assistant", kind: "error", content: "miki_error_local_model_unavailable" });
    const error = socket.sent.find((m) => m.type === "error");
    expect(error.payload).toMatchObject({ code: "local_model_unavailable", error_category: "local_model_unavailable", message: "miki_error_local_model_unavailable", retryable: true });
    expect(socket.types.slice(-3)).toEqual(["typing.stop", "node.run_end", "stream_done"]);
    expect(socket.sent[socket.sent.length - 1].payload.status).toBe("failed");
  });

  it("hides internal error details from the client but keeps the message retryable", async () => {
    const h = createHarness(async () => {
      throw new Error("SQLITE_CORRUPT: secret internals");
    });
    const socket = new FakeSocket();
    await h.send("hi", { socket: asSocket(socket) }).promise;
    const error = socket.sent.find((m) => m.type === "error");
    expect(error.payload.message).toBe("miki_error_provider_failure");
    expect(JSON.stringify(socket.sent)).not.toContain("secret internals");
    expect(h.logs.join("\n")).toContain("secret internals");
  });

  it("retries once on a transient failure that produced nothing", async () => {
    let call = 0;
    const h = createHarness(async (input) => {
      call += 1;
      if (call === 1) return { status: "failed", error: "fetch failed", toolCalls: [], model: "fake-model" };
      input.onEvent({ type: "message.final", runId: input.runId, content: "second try works" });
      return { status: "completed", finalText: "second try works", toolCalls: [], model: "fake-model" };
    });
    const socket = new FakeSocket();
    const outcome = await h.send("hi", { socket: asSocket(socket) }).promise;

    expect(outcome.status).toBe("completed");
    expect(h.agentCalls).toHaveLength(2);
    const statuses = socket.sent.filter((m) => m.type === "message.status").map((m) => m.payload.status);
    expect(statuses).toEqual(["processing", "retrying", "processing", "completed"]);
  });

  it("keeps retrying a transient failure through the 2s-12s cycle until the model answers", async () => {
    let call = 0;
    const retryIndexes: number[] = [];
    const h = createHarness(async (input) => {
      call += 1;
      if (call <= 5) return { status: "failed", error: "fetch failed", toolCalls: [], model: "fake-model" };
      input.onEvent({ type: "message.final", runId: input.runId, content: "finally answered" });
      return { status: "completed", finalText: "finally answered", toolCalls: [], model: "fake-model" };
    }, { retryDelayMs: (retryIndex) => { retryIndexes.push(retryIndex); return 0; } });
    const socket = new FakeSocket();
    const outcome = await h.send("hi", { socket: asSocket(socket) }).promise;

    expect(outcome.status).toBe("completed");
    expect(h.agentCalls).toHaveLength(6);
    expect(retryIndexes).toEqual([0, 1, 2, 3, 4]);
    const statuses = socket.sent.filter((m) => m.type === "message.status").map((m) => m.payload.status);
    expect(statuses).toEqual(["processing", "retrying", "processing", "retrying", "processing", "retrying", "processing", "retrying", "processing", "retrying", "processing", "completed"]);
  });

  it("asks the engine to resume in place and keeps the message 'retrying' during an outage instead of failing it", async () => {
    const h = createHarness(async (input) => {
      expect(input.retryTransient).toBe(true);
      input.onEvent({ type: "model.retrying", runId: input.runId, turn: 1, retry: 1, delayMs: 2000, reason: "fetch failed" });
      input.onEvent({ type: "model.resumed", runId: input.runId, turn: 1, retries: 1 });
      input.onEvent({ type: "message.final", runId: input.runId, content: "answered after outage" });
      return { status: "completed", finalText: "answered after outage", toolCalls: [], model: "fake-model" };
    });
    const socket = new FakeSocket();
    const outcome = await h.send("hi", { socket: asSocket(socket) }).promise;

    expect(outcome.status).toBe("completed");
    expect(h.agentCalls).toHaveLength(1);
    const statuses = socket.sent.filter((m) => m.type === "message.status").map((m) => m.payload.status);
    expect(statuses).toEqual(["processing", "retrying", "processing", "completed"]);
  });

  it("does not retry a failure that retrying cannot fix, such as a rejected API key", async () => {
    const h = createHarness(async () => ({ status: "failed", error: "401 invalid api key", toolCalls: [], model: "fake-model" }));
    const socket = new FakeSocket();
    const outcome = await h.send("hi", { socket: asSocket(socket) }).promise;

    expect(outcome.status).toBe("failed");
    expect(h.agentCalls).toHaveLength(1);
  });

  it("stops waiting between retries as soon as the user stops the turn", async () => {
    const h = createHarness(async (input) => {
      setTimeout(() => h.runner.cancelRetry(input.runId), 10);
      return { status: "failed", error: "fetch failed", toolCalls: [], model: "fake-model" };
    }, { retryDelayMs: () => 60_000 });
    const socket = new FakeSocket();
    const outcome = await h.send("hi", { socket: asSocket(socket) }).promise;

    expect(outcome.status).toBe("cancelled");
    expect(h.agentCalls).toHaveLength(1);
  });

  it("shows only the token-limit error when the model exhausts its token budget", async () => {
    const h = createHarness(async () => ({ status: "failed", error: "maximum output tokens exceeded", toolCalls: [], model: "fake-model" }));
    const socket = new FakeSocket();
    const outcome = await h.send("long task", { socket: asSocket(socket) }).promise;
    expect(outcome.status).toBe("failed");
    expect(h.messages().at(-1)).toMatchObject({ kind: "error", content: "miki_error_token_limit" });
  });

  it("normalizes network failures to the connection error", async () => {
    // A plain network failure is retried until the model answers or the user stops, so this case
    // needs a run that already used a tool: those are never retried (a retry could repeat side effects).
    const h = createHarness(async () => ({ status: "failed", error: "fetch failed", toolCalls: [{ name: "shell" }], model: "fake-model" }));
    const socket = new FakeSocket();
    await h.send("hello", { socket: asSocket(socket) }).promise;
    expect(h.messages().at(-1)).toMatchObject({ kind: "error", content: "miki_error_provider_network" });
  });

  it("rejects an empty message without touching the agent", async () => {
    const h = createHarness(answer("never"));
    const { promise, replies } = h.send("   ");
    const outcome = await promise;
    expect(outcome.status).toBe("rejected");
    expect(replies).toEqual([]);
    expect(h.agentCalls).toHaveLength(0);
    expect(h.messages()).toEqual([]);
  });

  describe("retry", () => {
    const seedFailedTurn = (h: ReturnType<typeof createHarness>) => {
      const at = "2026-01-01T00:00:00.000Z";
      h.db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id,status,status_detail) VALUES(?,?,?,?,?,?,?,?)").run("u1", SESSION, "user", "do it", at, CONTEXT, "failed", "boom");
      h.db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,kind,context_id) VALUES(?,?,?,?,?,?,?)").run("error-x", SESSION, "assistant", "boom", "2026-01-01T00:00:01.000Z", "error", CONTEXT);
    };

    it("re-runs a failed user message, dropping what the failed attempt left behind", async () => {
      const h = createHarness(answer("fixed"));
      seedFailedTurn(h);
      const outcome = await h.runner.run({
        sessionId: SESSION,
        contextId: CONTEXT,
        peerId: SESSION,
        trigger: { type: "user", mode: "retry", content: "", attachments: [], targetMessageId: "u1" },
      });

      expect(outcome.status).toBe("completed");
      expect(h.agentCalls[0].history.map((m: { content: string }) => m.content)).toEqual(["do it"]);
      expect(h.messages().map((m) => [m.id === "u1" ? "u1" : m.role, m.content, m.status])).toEqual([
        ["u1", "do it", "completed"],
        ["assistant", "fixed", "completed"],
      ]);
    });

    it("runs an older stopped message again as its own turn and leaves later messages in place", async () => {
      const h = createHarness(answer("handled the old ask"));
      const insert = h.db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,kind,context_id,status) VALUES(?,?,?,?,?,?,?,?)");
      insert.run("old", SESSION, "user", "also rename it", "2026-01-01T00:00:00.000Z", "normal", CONTEXT, "cancelled");
      insert.run("newer", SESSION, "user", "thanks", "2026-01-01T00:00:01.000Z", "normal", CONTEXT, "completed");
      insert.run("reply", SESSION, "assistant", "you are welcome", "2026-01-01T00:00:02.000Z", "normal", CONTEXT, "completed");
      const outcome = await h.runner.run({
        sessionId: SESSION,
        contextId: CONTEXT,
        peerId: SESSION,
        trigger: { type: "user", mode: "retry", content: "", attachments: [], targetMessageId: "old" },
      });

      expect(outcome.status).toBe("completed");
      expect(h.agentCalls[0].history.map((m: { content: string }) => m.content)).toContain("also rename it");
      expect(h.agentCalls[0].history.at(-1)?.role).toBe("system");
      expect(h.messages().find((m) => m.id === "old")?.status).toBe("completed");
      expect(h.messages().map((m) => m.content)).toContain("thanks");
      expect(h.messages().map((m) => m.content)).toContain("you are welcome");
    });

    it("runs again a message a restart interrupted mid-run once it is marked failed", async () => {
      const h = createHarness(answer("resumed"));
      const at = "2026-01-01T00:00:00.000Z";
      h.db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id,status) VALUES(?,?,?,?,?,?,?)").run("u1", SESSION, "user", "long job", at, CONTEXT, "processing");
      // What the gateway does on startup: mark the leftover message failed, then resume it.
      h.db.prepare("UPDATE chat_messages SET status='failed', status_detail='Interrupted by a gateway restart.' WHERE status IN ('queued','processing','retrying')").run();
      const outcome = await h.runner.run({
        sessionId: SESSION,
        contextId: CONTEXT,
        peerId: SESSION,
        trigger: { type: "user", mode: "retry", content: "", attachments: [], targetMessageId: "u1" },
      });

      expect(outcome.status).toBe("completed");
      expect(h.agentCalls).toHaveLength(1);
      expect(h.messages().find((m) => m.id === "u1")?.status).toBe("completed");
    });

    it("refuses to retry a message that is not the last one", async () => {
      const h = createHarness(answer("x"));
      const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
      h.db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id) VALUES(?,?,?,?,?,?)").run("u1", SESSION, "user", "old", at(0), CONTEXT);
      h.db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id) VALUES(?,?,?,?,?,?)").run("a1", SESSION, "assistant", "answer", at(1), CONTEXT);
      h.db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id) VALUES(?,?,?,?,?,?)").run("u2", SESSION, "user", "newer", at(2), CONTEXT);
      const replies: Array<{ type: string; payload: any }> = [];
      const outcome = await h.runner.run({
        sessionId: SESSION,
        contextId: CONTEXT,
        peerId: SESSION,
        reply: (type, payload) => replies.push({ type, payload }),
        trigger: { type: "user", mode: "retry", content: "", attachments: [], targetMessageId: "u1" },
      });

      expect(outcome.status).toBe("rejected");
      expect(replies).toEqual([{ type: "error", payload: { message: "Only the last chat message can be retried." } }]);
      expect(h.agentCalls).toHaveLength(0);
    });

    it("releases the conversation lane after a rejected retry", async () => {
      const h = createHarness(answer("ok"));
      const rejected = await h.runner.run({
        sessionId: SESSION,
        contextId: CONTEXT,
        peerId: SESSION,
        trigger: { type: "user", mode: "retry", content: "", attachments: [], targetMessageId: "missing" },
      });
      expect(rejected.status).toBe("rejected");
      const next = await h.send("still works").promise;
      expect(next.status).toBe("completed");
    });
  });

  it("keeps message ids unique across sessions: a client id owned by another session never drops the message", async () => {
    const h = createHarness(answer("ok"));
    h.db.prepare("INSERT INTO chat_sessions(id,title,created_at,updated_at) VALUES(?,?,?,?)").run("s2", "Other", "2026-01-01", "2026-01-01");
    h.db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id) VALUES(?,?,?,?,?,?)").run("shared-id", "s2", "user", "theirs", "2026-01-01T00:00:00.000Z", "channel:default-channel:peer:s2");
    const { promise, replies } = h.send("mine", {}, "shared-id");
    await promise;
    expect(replies[0].payload.message_id).not.toBe("shared-id");
    expect(h.messages().filter((m) => m.content === "mine")).toHaveLength(1);
  });

  it("(c) gives the next answer to a rated request the learned feedback as a note for the model", async () => {
    const note = "Earlier user feedback on this same request:\n- The user rejected an earlier answer to this same request. Their correction: keep it under 3 lines";
    const h = createHarness(answer("second draft"), {
      recallLearningFeedback: (question) => (question === "Summarise the report" ? note : undefined),
    });
    const outcome = await h.send("Summarise the report").promise;
    expect(outcome.status).toBe("completed");
    const history = h.agentCalls[0].history as Array<{ role: string; content: string }>;
    expect(history.some((m) => m.role === "system" && m.content === note)).toBe(true);
    // The note sits before the conversation, so the model reads it first.
    expect(history.findIndex((m) => m.content === note)).toBeLessThan(history.findIndex((m) => m.role === "user"));
  });

  it("(c) adds no feedback note for a request nobody rated", async () => {
    const h = createHarness(answer("plain"), { recallLearningFeedback: () => undefined });
    await h.send("Another question").promise;
    const history = h.agentCalls[0].history as Array<{ role: string; content: string }>;
    expect(history.some((m) => /feedback/i.test(m.content))).toBe(false);
  });

  it("gives the model learned guidance as a system note before the conversation", async () => {
    const note = "Learned guidance from Miki's own earlier self-review (advisory):\n- Lead with the result";
    const h = createHarness(answer("ok"), { recallLearnedGuidance: () => note });
    await h.send("Summarise the report").promise;
    const history = h.agentCalls[0].history as Array<{ role: string; content: string }>;
    expect(history.some((m) => m.role === "system" && m.content === note)).toBe(true);
    expect(history.findIndex((m) => m.content === note)).toBeLessThan(history.findIndex((m) => m.role === "user"));
  });

  it("still answers when learned guidance or the learned model choice fails", async () => {
    const h = createHarness(answer("ok"), {
      recallLearnedGuidance: () => { throw new Error("store locked"); },
      chooseLearnedModel: () => { throw new Error("policy unreadable"); },
    });
    const outcome = await h.send("hello there").promise;
    expect(outcome.status).toBe("completed");
    expect(h.logs.some((line) => line.includes("Learned guidance skipped"))).toBe(true);
    expect(h.logs.some((line) => line.includes("Learned model choice skipped"))).toBe(true);
  });

  it("runs the model that learned rewards favour when the user did not pick one", async () => {
    const choose = jest.fn().mockReturnValue("better-model");
    const h = createHarness(answer("ok"), { chooseLearnedModel: choose });
    await h.send("Summarise the report").promise;
    expect(choose).toHaveBeenCalledWith("Summarise the report");
    expect(h.agentCalls[0].model).toBe("better-model");
  });

  it("never overrides a model the user picked", async () => {
    const choose = jest.fn().mockReturnValue("better-model");
    const h = createHarness(answer("ok"), { chooseLearnedModel: choose });
    await h.send("Summarise the report", { trigger: { type: "user", mode: "send", content: "Summarise the report", attachments: [], requestedModel: "my-pick" } as any }).promise;
    expect(choose).not.toHaveBeenCalled();
    expect(h.agentCalls[0].model).toBe("my-pick");
  });

  it("checks every new message for feedback on the previous answer, in the background", async () => {
    const detect = jest.fn().mockResolvedValue(undefined);
    const h = createHarness(answer("first"), { detectFollowUpFeedback: detect });
    await h.send("first question").promise;
    await h.send("no, make it shorter").promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(detect).toHaveBeenCalledTimes(2);
    expect(detect.mock.calls[1][0]).toMatchObject({ sessionId: SESSION, contextId: CONTEXT, followUp: "no, make it shorter" });
  });

  it("a failing feedback lookup never blocks the turn", async () => {
    const h = createHarness(answer("still answered"), {
      recallLearningFeedback: () => { throw new Error("learning store locked"); },
    });
    const outcome = await h.send("hello").promise;
    expect(outcome.status).toBe("completed");
    expect(h.messages().map((m) => m.content)).toContain("still answered");
    expect(h.logs.some((line) => /Learning recall skipped/.test(line))).toBe(true);
  });
});
