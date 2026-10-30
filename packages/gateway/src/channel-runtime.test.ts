import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { ChannelRuntimeManager, channelSettings, isChannelSenderAllowed, parseAllowFrom } from "./channel-runtime.js";
import { ChannelDeliveryStore } from "./outbox.js";


class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  constructor(public readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit("close"); }
}

function runtimeEntry() {
  return {
    signature: "test",
    controller: new AbortController(),
    state: { runtime_live: true, connected: false, enabled: true, configured: true },
    sockets: new Set(),
    worker: Promise.resolve(),
  };
}

/** Real in-memory SQLite with the chat_messages table; `reply` is the assistant answer the fake run "produces". */
function runtimeDb(reply = "Hello from Miki") {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT, kind TEXT DEFAULT 'normal', context_id TEXT, status TEXT DEFAULT 'completed', status_detail TEXT)");
  (db as any).__reply = reply;
  return db;
}

/** What the real runner leaves behind after a successful turn: the answer saved as an assistant message. */
function completeTurn(db: Database.Database, input: { contextId: string; sessionId: string }, runId: string, reply = "Hello from Miki") {
  db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id,kind) VALUES(?,?,?,?,?,?,'normal')").run(`assistant-${runId}`, input.sessionId, "assistant", reply, new Date(Date.now() + 2).toISOString(), input.contextId);
  return { status: "completed", runId };
}

/** A chat-turn runner double that stores the user message and the assistant answer like the real runner does. */
function fakeTurns(db: Database.Database, options: { status?: string; detail?: string; reply?: string } = {}) {
  let n = 0;
  return { run: jest.fn(async (input: { contextId: string; sessionId: string; trigger: { clientMessageId?: string; content: string } }) => {
    const id = input.trigger.clientMessageId as string;
    const exists = db.prepare("SELECT id FROM chat_messages WHERE id=?").get(id);
    if (exists) return { status: "duplicate" };
    const stamp = new Date(Date.now() + 1).toISOString();
    db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id,status,status_detail) VALUES(?,?,?,?,?,?,?,?)").run(id, input.sessionId, "user", input.trigger.content, stamp, input.contextId, options.status === "failed" ? "failed" : "completed", options.detail ?? null);
    if (options.status !== "failed") db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id,kind) VALUES(?,?,?,?,?,?,'normal')").run(`assistant-${++n}`, input.sessionId, "assistant", options.reply ?? "Hello from Miki", new Date(Date.now() + 2).toISOString(), input.contextId);
    return { status: options.status ?? "completed", runId: `run-${n}` };
  }), waitForRun: jest.fn(async () => "completed") };
}

describe("external channel runtime", () => {
  it("parses allow_from without duplicates and uses exact sender matching", () => {
    expect(parseAllowFrom("123, 456;123\n789")).toEqual(["123", "456", "789"]);
    expect(isChannelSenderAllowed(["123"], "123")).toBe(true);
    expect(isChannelSenderAllowed(["123"], "1234")).toBe(false);
    expect(isChannelSenderAllowed([], "123")).toBe(false);
    expect(isChannelSenderAllowed(["*"], "anyone")).toBe(true);
  });

  it("loads channel credentials from the encrypted-secret hydration shape and defaults disabled", () => {
    const config = {
      channel_list: {
        telegram: { enabled: true, allow_from: ["100"], settings: { token: "bot-secret" } },
        discord: { enabled: false, settings: { token: "disabled-secret" } },
        slack: { enabled: true, allow_from: "200", settings: { bot_token: "xoxb-bot", app_token: "xapp-app" } },
      },
    };
    expect(channelSettings(config, "telegram")).toMatchObject({ enabled: true, token: "bot-secret", allowFrom: ["100"] });
    expect(channelSettings(config, "discord").enabled).toBe(false);
    expect(channelSettings(config, "slack")).toMatchObject({ token: "xoxb-bot", appToken: "xapp-app", allowFrom: ["200"] });
  });

  it("is active by default and only an explicit enabled:false turns a channel off", () => {
    const config = {
      channel_list: {
        telegram: { settings: { token: "bot-secret" } },
        discord: { enabled: false, settings: { token: "off" } },
      },
    };
    expect(channelSettings(config, "telegram").enabled).toBe(true);
    expect(channelSettings(config, "discord").enabled).toBe(false);
    expect(channelSettings({}, "slack").enabled).toBe(true);
  });

  it("connects with credentials alone; an empty allow_from does not stop activation", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })) as unknown as typeof fetch;
    const db = {} as never;
    const chatTurns = { run: jest.fn() } as never;
    const config = { channel_list: { telegram: { settings: { token: "test-token" } } } };
    const manager = new ChannelRuntimeManager({ db, chatTurns, getAppConfig: () => config, log: () => undefined, fetchImpl, now: () => new Date().toISOString() });
    try {
      await manager.reconcile();
      expect(manager.status("telegram")).toMatchObject({ enabled: true, configured: true, runtime_live: true });
      expect(manager.status("discord")).toMatchObject({ configured: false });
    } finally {
      await manager.close();
    }
  });

  it("performs one authenticated test delivery and makes retries idempotent without storing message content or recipient IDs", async () => {
    const db = new Database(":memory:")
    const calls: Array<{ url: string; body: Record<string, unknown>; authorization?: string }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, authorization: new Headers(init?.headers).get("authorization") ?? undefined })
      return new Response(JSON.stringify({ ok: true, result: { message_id: 987654 } }), { status: 200 })
    }
    const config = { channel_list: { telegram: { enabled: true, settings: { token: "do-not-save-this-token" } } } }
    const manager = new ChannelRuntimeManager({ db, chatTurns: {} as never, getAppConfig: () => config, log: () => undefined, fetchImpl })
    try {
      const first = await manager.sendTestMessage("telegram", "test-recipient-100", "MIKI-E2E:run-abc12345", "run-abc12345")
      const duplicate = await manager.sendTestMessage("telegram", "test-recipient-100", "MIKI-E2E:run-abc12345", "run-abc12345")
      expect(first).toMatchObject({ status: "sent", providerAckId: "987654", idempotencyKey: "run-abc12345" })
      expect(duplicate).toMatchObject({ status: "duplicate", providerAckId: "987654" })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.body).toMatchObject({ chat_id: "test-recipient-100", text: "MIKI-E2E:run-abc12345" })
      expect(calls[0]?.authorization).toBeUndefined()
      const stored = JSON.stringify(db.prepare("SELECT * FROM channel_test_deliveries").all())
      expect(stored).not.toContain("test-recipient-100")
      expect(stored).not.toContain("MIKI-E2E")
      expect(stored).not.toContain("do-not-save-this-token")
      await expect(manager.sendTestMessage("telegram", "different-recipient", "MIKI-E2E:run-abc12345", "run-abc12345")).rejects.toThrow("channel_test_idempotency_key_conflict")
    } finally { await manager.close(); db.close() }
  })

  it("validates provider acknowledgements for Discord and Slack test deliveries", async () => {
    for (const name of ["discord", "slack"] as const) {
      const db = new Database(":memory:")
      const calls: Array<{ url: string; authorization?: string }> = []
      const fetchImpl: typeof fetch = async (input, init) => {
        calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") ?? undefined })
        const body = name === "discord" ? { id: "discord-ack-101" } : { ok: true, ts: "slack-ack-101" }
        return new Response(JSON.stringify(body), { status: 200 })
      }
      const settings = name === "slack" ? { bot_token: "slack-bot-secret", app_token: "slack-app-secret" } : { token: "discord-bot-secret" }
      const config = { channel_list: { [name]: { enabled: true, settings } } }
      const manager = new ChannelRuntimeManager({ db, chatTurns: {} as never, getAppConfig: () => config, log: () => undefined, fetchImpl })
      try {
        const key = `run-${name}-12345`
        const result = await manager.sendTestMessage(name, "test-destination-100", `MIKI-E2E:${key}`, key)
        expect(result).toMatchObject({ status: "sent", providerAckId: name === "discord" ? "discord-ack-101" : "slack-ack-101" })
        expect(calls[0]?.url).toContain(name === "discord" ? "/channels/test-destination-100/messages" : "chat.postMessage")
        expect(calls[0]?.authorization).toBe(name === "discord" ? "Bot discord-bot-secret" : "Bearer slack-bot-secret")
      } finally { await manager.close(); db.close() }
    }
  })

  it("sends proactive Telegram notices only to explicit allow_from user IDs", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const config = { channel_list: { telegram: { enabled: true, allow_from: ["123", "*", "456"], settings: { token: "telegram-secret" } } } };
    const manager = new ChannelRuntimeManager({ db: {} as never, chatTurns: {} as never, getAppConfig: () => config, log: () => undefined, fetchImpl });
    await manager.sendProactiveNotice("The background task finished.");
    expect(requests).toEqual([
      { url: "https://api.telegram.org/bottelegram-secret/sendMessage", body: { chat_id: "123", text: "The background task finished.", disable_web_page_preview: true } },
      { url: "https://api.telegram.org/bottelegram-secret/sendMessage", body: { chat_id: "456", text: "The background task finished.", disable_web_page_preview: true } },
    ]);
    await manager.close();
  });

  it("opens a Discord DM for each allow-listed recipient before sending", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, method: String(init?.method), body });
      return url.endsWith("/users/@me/channels")
        ? new Response(JSON.stringify({ id: "dm-channel-1" }), { status: 200 })
        : new Response("{}", { status: 200 });
    };
    const config = { channel_list: { discord: { enabled: true, allow_from: ["discord-user-9"], settings: { token: "discord-secret" } } } };
    const manager = new ChannelRuntimeManager({ db: {} as never, chatTurns: {} as never, getAppConfig: () => config, log: () => undefined, fetchImpl });
    await manager.sendProactiveNotice("A Discord notice.");
    expect(requests).toEqual([
      { url: "https://discord.com/api/v10/users/@me/channels", method: "POST", body: { recipient_id: "discord-user-9" } },
      { url: "https://discord.com/api/v10/channels/dm-channel-1/messages", method: "POST", body: { content: "A Discord notice.", allowed_mentions: { parse: [] } } },
    ]);
    await manager.close();
  });

  it("sends proactive Slack notices to allow-listed user IDs through chat.postMessage", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const config = { channel_list: { slack: { enabled: true, allow_from: ["U123", "*"], settings: { bot_token: "slack-token", app_token: "slack-app" } } } };
    const manager = new ChannelRuntimeManager({ db: {} as never, chatTurns: {} as never, getAppConfig: () => config, log: () => undefined, fetchImpl });
    await manager.sendProactiveNotice("Slack notice.");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://slack.com/api/chat.postMessage");
    expect(requests[0].body).toMatchObject({ channel: "U123", text: "Slack notice." });
    await manager.close();
  });

  it("skips disabled channels, channels without credentials, and channels without recipients", async () => {
    const fetchImpl = jest.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const config = { channel_list: {
      telegram: { enabled: false, allow_from: ["123"], settings: { token: "disabled-token" } },
      discord: { enabled: true, allow_from: ["456"] },
      slack: { enabled: true, allow_from: ["789"], settings: { app_token: "slack-app" } },
    } };
    const manager = new ChannelRuntimeManager({ db: {} as never, chatTurns: {} as never, getAppConfig: () => config, log: () => undefined, fetchImpl });
    await manager.sendProactiveNotice("Notice.");
    expect(fetchImpl).not.toHaveBeenCalled();
    await manager.close();
  });

  it("continues after a recipient failure without logging provider errors or secrets", async () => {
    const attempted: string[] = [];
    const logged: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { chat_id?: string };
      attempted.push(String(body.chat_id));
      return new Response("{}", { status: body.chat_id === "first" ? 500 : 200 });
    };
    const config = { channel_list: { telegram: { enabled: true, allow_from: ["first", "second"], settings: { token: "telegram-secret" } } } };
    const manager = new ChannelRuntimeManager({ db: {} as never, chatTurns: {} as never, getAppConfig: () => config, log: (message) => logged.push(message), fetchImpl });
    await expect(manager.sendProactiveNotice("Do not log this text.")).resolves.toBeUndefined();
    expect(attempted).toEqual(["first", "second"]);
    expect(logged).toEqual(["telegram proactive notice delivery failed; channel request was unsuccessful."]);
    expect(logged.join(" ")).not.toContain("telegram-secret");
    expect(logged.join(" ")).not.toContain("Do not log this text.");
    await manager.close();
  });

  it("acks Slack Socket Mode envelopes and replies through chat.postMessage", async () => {
    FakeWebSocket.instances = [];
    let resolveReply!: () => void;
    const replySent = new Promise<void>((resolve) => { resolveReply = resolve; });
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toContain("https://slack.com/api/chat.postMessage");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxb-test");
      expect(JSON.parse(String(init?.body))).toMatchObject({ channel: "C456", text: "Hello from Miki" });
      resolveReply();
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const db = runtimeDb();
    const chatTurns = { run: jest.fn(async (input: { contextId: string; sessionId: string; trigger: { content: string }; peerId: string }) => {
      expect(input.peerId).toBe("U123");
      expect(input.trigger.content).toBe("hello from Slack");
      return completeTurn(db, input, "slack-run");
    }) } as never;
    const manager = new ChannelRuntimeManager({ db, chatTurns, getAppConfig: () => ({ channel_list: { slack: { enabled: true, allow_from: ["U123"], settings: { bot_token: "xoxb-test", app_token: "xapp-test" } } } }), log: () => undefined, fetchImpl, WebSocketImpl: FakeWebSocket as never });
    const entry = runtimeEntry() as never;
    const connected = (manager as any).connectSlack({ name: "slack", enabled: true, token: "xoxb-test", appToken: "xapp-test", allowFrom: ["U123"] }, entry, "wss://slack.example/socket");
    const socket = FakeWebSocket.instances[0];
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "events_api", envelope_id: "env-1", payload: { event_id: "Ev-1", event: { type: "message", user: "U123", channel: "C456", text: "hello from Slack" } } })));
    try {
      await Promise.race([replySent, new Promise((_, reject) => setTimeout(() => reject(new Error("Slack adapter did not reply")), 1000))]);
      expect(socket.sent[0]).toEqual({ envelope_id: "env-1" });
      expect(chatTurns.run).toHaveBeenCalledTimes(1);
    } finally {
      (entry as any).controller.abort();
      await connected;
      await manager.close();
    }
  });

  it("identifies on Discord Gateway and processes only an allow-listed message", async () => {
    FakeWebSocket.instances = [];
    let resolveReply!: () => void;
    const replySent = new Promise<void>((resolve) => { resolveReply = resolve; });
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toContain("https://discord.com/api/v10/channels/C123/messages");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bot discord-test");
      expect(JSON.parse(String(init?.body))).toMatchObject({ content: "Hello from Miki", allowed_mentions: { parse: [] } });
      resolveReply();
      return new Response("{}", { status: 200 });
    };
    const db = runtimeDb();
    const chatTurns = { run: jest.fn(async (input: { contextId: string; sessionId: string; trigger: { content: string }; peerId: string }) => {
      expect(input.peerId).toBe("D123");
      expect(input.trigger.content).toBe("hello from Discord");
      return completeTurn(db, input, "discord-run");
    }) } as never;
    const manager = new ChannelRuntimeManager({ db, chatTurns, getAppConfig: () => ({ channel_list: { discord: { enabled: true, allow_from: ["D123"], settings: { token: "discord-test" } } } }), log: () => undefined, fetchImpl, WebSocketImpl: FakeWebSocket as never });
    const entry = runtimeEntry() as never;
    const connected = (manager as any).connectDiscord({ name: "discord", enabled: true, token: "discord-test", allowFrom: ["D123"] }, entry, "wss://discord.example/?v=10&encoding=json");
    const socket = FakeWebSocket.instances[0];
    socket.emit("message", Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })));
    expect(socket.sent[0]).toMatchObject({ op: 2, d: { token: "discord-test" } });
    socket.emit("message", Buffer.from(JSON.stringify({ op: 0, s: 1, t: "READY", d: { user: { id: "bot-id" } } })));
    socket.emit("message", Buffer.from(JSON.stringify({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "evt-1", channel_id: "C123", content: "hello from Discord", author: { id: "D123", username: "trusted", bot: false } } })));
    try {
      await Promise.race([replySent, new Promise((_, reject) => setTimeout(() => reject(new Error("Discord adapter did not reply")), 1000))]);
      expect(chatTurns.run).toHaveBeenCalledTimes(1);
      expect((entry as any).state.connected).toBe(true);
    } finally {
      (entry as any).controller.abort();
      await connected;
      await manager.close();
    }
  });

  it("polls Telegram, ignores messages outside allow_from, processes an allowed message once and replies", async () => {
    let pollCount = 0;
    let resolveReply!: () => void;
    const replySent = new Promise<void>((resolve) => { resolveReply = resolve; });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("getUpdates")) {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(JSON.stringify({ ok: true, result: [
            { update_id: 101, message: { message_id: 7, from: { id: 999, is_bot: false }, chat: { id: 999 }, text: "do not answer" } },
            { update_id: 102, message: { message_id: 8, from: { id: 123, is_bot: false, username: "trusted" }, chat: { id: 123 }, text: "hello" } },
          ] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("sendMessage")) {
        const body = JSON.parse(String(init?.body || "{}")) as { chat_id?: number | string; text?: string };
        expect(body.chat_id).toBe("123");
        expect(body.text).toBe("Hello from Miki");
        resolveReply();
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected mock URL: ${url}`);
    };
    const db = runtimeDb();
    const chatTurns = { run: jest.fn(async (input: { contextId: string; sessionId: string; trigger: { content: string; clientMessageId?: string }; peerId: string }) => {
      expect(input.peerId).toBe("123");
      expect(input.trigger.content).toBe("hello");
      expect(input.trigger.clientMessageId).toBe("telegram_102");
      return completeTurn(db, input, "run-1");
    }) } as never;
    const config = { channel_list: { telegram: { enabled: true, allow_from: ["123"], settings: { token: "test-token" } } } };
    const manager = new ChannelRuntimeManager({ db, chatTurns, getAppConfig: () => config, log: () => undefined, fetchImpl, now: () => new Date().toISOString() });
    try {
      await manager.reconcile();
      await Promise.race([replySent, new Promise((_, reject) => setTimeout(() => reject(new Error("Telegram adapter did not reply")), 1000))]);
      expect(chatTurns.run).toHaveBeenCalledTimes(1);
      expect(manager.status("telegram")).toMatchObject({ runtime_live: true, configured: true });
    } finally {
      await manager.close();
    }
  });
});

describe("durable channel delivery (outbox)", () => {
  const config = { channel_list: { telegram: { enabled: true, allow_from: ["123"], settings: { token: "tg-token" } } } };
  const entry = () => runtimeEntry() as never;
  const sendInput = (eventId: string, text = "hello") => ({ channel: "telegram" as const, address: "123", senderId: "123", eventId, text, allowFrom: ["123"], entry: entry() });
  const waitFor = async (check: () => boolean, ms = 1500) => {
    const end = Date.now() + ms;
    while (!check()) { if (Date.now() > end) throw new Error("condition not reached"); await new Promise((r) => setTimeout(r, 5)); }
  };

  function build(options: { status?: string; detail?: string; online?: { value: boolean } } = {}) {
    const db = runtimeDb();
    const sent: Array<{ chat_id: string; text: string }> = [];
    const online = options.online ?? { value: true };
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (!online.value) throw new Error("network down");
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const chatTurns = fakeTurns(db, { status: options.status, detail: options.detail });
    const delivery = new ChannelDeliveryStore(db, { baseDelayMs: 5, maxDelayMs: 20 });
    const manager = new ChannelRuntimeManager({ db, chatTurns: chatTurns as never, getAppConfig: () => config, log: () => undefined, fetchImpl, delivery });
    return { db, sent, online, chatTurns, delivery, manager };
  }

  it("keeps a reply whose send failed and delivers it once when the network returns", async () => {
    const { manager, sent, online, delivery } = build({ online: { value: false } });
    try {
      await (manager as any).dispatchMessage(sendInput("1"));
      await new Promise((r) => setTimeout(r, 30));
      expect(sent).toHaveLength(0);
      expect(delivery.stats().pending).toBe(1); // the answer is still waiting, not lost
      online.value = true;
      manager.flushOutbox();
      await waitFor(() => sent.length === 1);
      expect(sent[0]).toMatchObject({ chat_id: "123", text: "Hello from Miki" });
      manager.flushOutbox();
      await new Promise((r) => setTimeout(r, 30));
      expect(sent).toHaveLength(1); // no duplicate
      expect(delivery.stats().pending).toBe(0);
    } finally { await manager.close(); }
  });

  it("tells the user on the channel when the turn failed, instead of staying silent", async () => {
    const { manager, sent } = build({ status: "failed", detail: "model server unreachable" });
    try {
      await (manager as any).dispatchMessage(sendInput("2"));
      await waitFor(() => sent.length === 1);
      expect(sent[0].text).toContain("request_failed");
      expect(sent[0].text).toContain("model server unreachable");
    } finally { await manager.close(); }
  });

  it("answers a platform re-delivery whose reply was never queued, but not one already answered", async () => {
    const { manager, sent, db, delivery } = build();
    try {
      // The first delivery completed, but the process stopped before the reply was queued.
      delivery.recordInbound({ eventId: "telegram_3", channel: "telegram", address: "123", senderId: "123" });
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id,status) VALUES('telegram_3','channel-telegram-123','user','hello','2026-10-27T10:00:00.000Z','channel:telegram:address:123:peer:123','completed')").run();
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id,kind) VALUES('assistant-old','channel-telegram-123','assistant','Saved answer','2026-10-27T10:00:05.000Z','channel:telegram:address:123:peer:123','normal')").run();
      await (manager as any).dispatchMessage(sendInput("3"));
      await waitFor(() => sent.length === 1);
      expect(sent[0].text).toBe("Saved answer");
      await (manager as any).dispatchMessage(sendInput("3")); // delivered a third time by the platform
      await new Promise((r) => setTimeout(r, 30));
      expect(sent).toHaveLength(1);
    } finally { await manager.close(); }
  });

  it("sends the answer of a message resumed after a restart to the channel it came from", async () => {
    const { manager, sent, db, delivery } = build();
    try {
      delivery.recordInbound({ eventId: "telegram_4", channel: "telegram", address: "123", senderId: "123" });
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id,status) VALUES('telegram_4','channel-telegram-123','user','hello','2026-10-27T10:00:00.000Z','channel:telegram:address:123:peer:123','queued')").run();
      const outcome = await manager.resumeInbound("telegram_4", async () => completeTurn(db, { contextId: "channel:telegram:address:123:peer:123", sessionId: "channel-telegram-123" }, "resume-1", "Resumed answer"));
      expect(outcome.status).toBe("completed");
      await waitFor(() => sent.length === 1);
      expect(sent[0]).toMatchObject({ chat_id: "123", text: "Resumed answer" });
    } finally { await manager.close(); }
  });

  it("runs a message that did not come from a channel without touching the outbox", async () => {
    const { manager, sent } = build();
    try {
      const run = jest.fn(async () => ({ status: "completed", runId: "web-run" }));
      await manager.resumeInbound("web-message-1", run as never);
      expect(run).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 20));
      expect(sent).toHaveLength(0);
    } finally { await manager.close(); }
  });

  it("splits a long reply into ordered parts", async () => {
    const { manager, sent } = build();
    const long = `${"a".repeat(3900)}\n${"b".repeat(3900)}`;
    try {
      (manager as any).queueOutbound({ channel: "telegram", address: "123", chatMessageId: "long-1", text: long });
      await waitFor(() => sent.length === 2);
      expect(sent[0].text.startsWith("a")).toBe(true);
      expect(sent[1].text.startsWith("b")).toBe(true);
    } finally { await manager.close(); }
  });
});

describe("channel connection hardening", () => {
  const waitFor = async (check: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!check()) { if (Date.now() > end) throw new Error("condition not reached"); await new Promise((r) => setTimeout(r, 10)); }
  };
  const discordSettings = { name: "discord", enabled: true, token: "discord-test", allowFrom: ["D1"] };
  const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const quietTurns = (db: Database.Database) => ({ run: jest.fn(async (input: { contextId: string; sessionId: string }) => completeTurn(db, input, `r${Math.random()}`)), waitForRun: jest.fn(async () => "completed") }) as never;

  it("Discord: a dropped connection RESUMEs the saved session instead of identifying again", async () => {
    FakeWebSocket.instances = [];
    const db = runtimeDb();
    const manager = new ChannelRuntimeManager({ db, chatTurns: quietTurns(db), getAppConfig: () => ({}), log: () => undefined, fetchImpl: (async () => jsonResponse([])) as never, WebSocketImpl: FakeWebSocket as never });
    const entry = runtimeEntry() as never;
    try {
      const first = (manager as any).connectDiscord(discordSettings, entry, "wss://d/?v=10");
      const s1 = FakeWebSocket.instances[0];
      s1.emit("message", Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })));
      expect(s1.sent[0]).toMatchObject({ op: 2 }); // first connection identifies
      s1.emit("message", Buffer.from(JSON.stringify({ op: 0, s: 5, t: "READY", d: { session_id: "sess-1", resume_gateway_url: "wss://resume.example" } })));
      s1.close();
      await first;
      expect((entry as any).discord).toMatchObject({ sessionId: "sess-1", resumeUrl: "wss://resume.example", seq: 5 });
      const second = (manager as any).connectDiscord(discordSettings, entry, "wss://resume.example/?v=10");
      const s2 = FakeWebSocket.instances[1];
      s2.emit("message", Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })));
      expect(s2.sent[0]).toEqual({ op: 6, d: { token: "discord-test", session_id: "sess-1", seq: 5 } });
      // Discord says the session is gone: it is forgotten so the next connection identifies again.
      s2.emit("message", Buffer.from(JSON.stringify({ op: 9, d: false })));
      await second;
      expect((entry as any).discord.sessionId).toBeUndefined();
    } finally { (entry as any).controller.abort(); await manager.close(); }
  });

  it("Discord: a heartbeat that is never acknowledged ends the half-open connection", async () => {
    FakeWebSocket.instances = [];
    const db = runtimeDb();
    const logs: string[] = [];
    const manager = new ChannelRuntimeManager({ db, chatTurns: quietTurns(db), getAppConfig: () => ({}), log: (m) => logs.push(m), fetchImpl: (async () => jsonResponse([])) as never, WebSocketImpl: FakeWebSocket as never });
    const entry = runtimeEntry() as never;
    try {
      const done = (manager as any).connectDiscord(discordSettings, entry, "wss://d/?v=10");
      FakeWebSocket.instances[0].emit("message", Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } })));
      await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("half-open connection was not detected")), 4000))]);
      expect(logs.join(" ")).toContain("heartbeat was not acknowledged");
    } finally { (entry as any).controller.abort(); await manager.close(); }
  });

  it("Discord: after a fresh session it asks for the messages missed since the last one seen and answers them oldest first", async () => {
    FakeWebSocket.instances = [];
    const db = runtimeDb();
    const delivery = new ChannelDeliveryStore(db, { baseDelayMs: 5 });
    delivery.setCursor("discord", "C9", "100", (a, b) => BigInt(a) > BigInt(b));
    const handled: string[] = [];
    const chatTurns = { run: jest.fn(async (input: { contextId: string; sessionId: string; trigger: { clientMessageId?: string } }) => { handled.push(String(input.trigger.clientMessageId)); return completeTurn(db, input, `c-${handled.length}`); }), waitForRun: jest.fn(async () => "completed") } as never;
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/channels/C9/messages?after=100")) return jsonResponse([
        { id: "103", content: "third", author: { id: "D1", bot: false } },
        { id: "101", content: "first", author: { id: "D1", bot: false } },
        { id: "102", content: "from a bot", author: { id: "bot", bot: true } },
      ]);
      return jsonResponse({ ok: true });
    };
    const manager = new ChannelRuntimeManager({ db, chatTurns, getAppConfig: () => ({ channel_list: { discord: { enabled: true, allow_from: ["D1"], settings: { token: "discord-test" } } } }), log: () => undefined, fetchImpl, WebSocketImpl: FakeWebSocket as never, delivery });
    const entry = runtimeEntry() as never;
    try {
      const done = (manager as any).connectDiscord(discordSettings, entry, "wss://d/?v=10");
      const socket = FakeWebSocket.instances[0];
      socket.emit("message", Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })));
      socket.emit("message", Buffer.from(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "s", resume_gateway_url: "wss://r" } })));
      await waitFor(() => handled.length === 2);
      expect(handled).toEqual(["discord_101", "discord_103"]);
      expect(delivery.getCursor("discord", "C9")).toBe("103");
      socket.close(); await done;
    } finally { (entry as any).controller.abort(); await manager.close(); }
  });

  it("Slack: a silent connection is replaced, and missed messages are fetched on reconnect", async () => {
    FakeWebSocket.instances = [];
    const db = runtimeDb();
    const delivery = new ChannelDeliveryStore(db, { baseDelayMs: 5 });
    delivery.setCursor("slack", "C5", "1700000000.000100", (a, b) => Number(a) > Number(b));
    const handled: string[] = [];
    const chatTurns = { run: jest.fn(async (input: { contextId: string; sessionId: string; trigger: { clientMessageId?: string } }) => { handled.push(String(input.trigger.clientMessageId)); return completeTurn(db, input, `s-${handled.length}`); }), waitForRun: jest.fn(async () => "completed") } as never;
    const fetchImpl: typeof fetch = async (input) => String(input).includes("conversations.history")
      ? jsonResponse({ ok: true, messages: [{ ts: "1700000005.000200", user: "U1", text: "missed while offline" }, { ts: "1700000006.000300", bot_id: "B1", text: "bot" }] })
      : jsonResponse({ ok: true });
    const manager = new ChannelRuntimeManager({ db, chatTurns, getAppConfig: () => ({}), log: () => undefined, fetchImpl, WebSocketImpl: FakeWebSocket as never, delivery, staleMs: 3000 });
    const entry = runtimeEntry() as never;
    try {
      const done = (manager as any).connectSlack({ name: "slack", enabled: true, token: "xoxb-1", appToken: "xapp-1", allowFrom: ["U1"] }, entry, "wss://slack.example/socket");
      FakeWebSocket.instances[0].emit("open");
      await waitFor(() => handled.length === 1);
      expect(handled[0]).toBe("slack_C5_1700000005_000200");
      // No event, ping or pong arrives: the connection is half-open and must be dropped.
      await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("silent connection was not replaced")), 6000))]);
    } finally { (entry as any).controller.abort(); await manager.close(); }
  }, 12000);
});
