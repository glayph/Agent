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

function createHarness(startRun: StartRun) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal', model_name TEXT, context_id TEXT, image_urls TEXT, attachments_json TEXT, status TEXT NOT NULL DEFAULT 'completed', status_detail TEXT);
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
      llmFor: () => ({ model: "fake-model" }),
      startRun: (input) => {
        agentCalls.push(input);
        return startRun(input);
      },
      cancelRun: () => undefined,
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
    createWsEventMapper: ((emit: (type: string, payload: unknown) => void) => ({
      finalIds: [] as string[],
      finalId: `final-${Math.random().toString(36).slice(2)}`,
      attachments: () => [],
      handle: (event: { type?: string; content?: string; runId?: string }) => {
        if (event.type === "message.final") emit("message.final", { content: event.content });
      },
    })) as any,
    planAdaptiveOutput: ((message: { id: string; content: string }) => [{ id: message.id, content: message.content }]) as any,
    getLifecycleBus: (() => ({ emit: (event: string, payload: unknown) => emitted.push({ event, payload }) })) as any,
    retrieveRelevantTurns: (() => []) as any,
    resolveContextWindowTokens: (() => 8192) as any,
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

  it("serializes turns of one conversation, and the second sees the first answer in its history", async () => {
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
    expect(second.replies[0].payload).toMatchObject({ status: "queued", queue_position: 1 });

    releaseFirst();
    await Promise.all([first.promise, second.promise]);

    expect(h.agentCalls).toHaveLength(2);
    // The second turn only started after the first answer was saved, so that answer is in its history.
    // (Order is by created_at; a queued message is stored on arrival, which is before the answer it waited for.)
    const secondHistory = h.agentCalls[1].history.map((m: { role: string; content: string }) => `${m.role}:${m.content}`);
    expect(secondHistory.sort()).toEqual(["assistant:reply 1", "user:first", "user:second"]);
    expect(h.messages().map((m) => m.content).sort()).toEqual(["first", "reply 1", "reply 2", "second"]);
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
    expect(rows[1]).toMatchObject({ role: "assistant", kind: "error", content: "Local model is unavailable." });
    const error = socket.sent.find((m) => m.type === "error");
    expect(error.payload).toMatchObject({ code: "local_model_unavailable", error_category: "local_model_unavailable", retryable: true });
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
    expect(error.payload.message).toBe("An internal error interrupted this chat run. Your message was saved; you can retry it.");
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
});
