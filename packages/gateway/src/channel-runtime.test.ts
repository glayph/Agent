import { EventEmitter } from "node:events";
import { ChannelRuntimeManager, channelSettings, isChannelSenderAllowed, parseAllowFrom } from "./channel-runtime.js";


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

function runtimeDb() {
  return {
    prepare(sql: string) {
      return {
        get() {
          if (sql.includes("SELECT id FROM chat_messages")) return undefined;
          if (sql.includes("SELECT id,content FROM chat_messages")) return { id: "assistant-1", content: "Hello from Miki" };
          return undefined;
        },
      };
    },
  } as never;
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

  it("skips disabled channels, channels without credentials, and channels without recipients", async () => {
    const fetchImpl = jest.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const config = { channel_list: {
      telegram: { enabled: false, allow_from: ["123"], settings: { token: "disabled-token" } },
      discord: { enabled: true, allow_from: ["456"] },
      slack: { enabled: true, allow_from: ["789"], settings: { bot_token: "slack-token", app_token: "slack-app" } },
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
    const chatTurns = { run: jest.fn(async (input: { trigger: { content: string }; peerId: string }) => {
      expect(input.peerId).toBe("U123");
      expect(input.trigger.content).toBe("hello from Slack");
      return { status: "completed", runId: "slack-run" };
    }) } as never;
    const manager = new ChannelRuntimeManager({ db: runtimeDb(), chatTurns, getAppConfig: () => ({}), log: () => undefined, fetchImpl, WebSocketImpl: FakeWebSocket as never });
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
    const chatTurns = { run: jest.fn(async (input: { trigger: { content: string }; peerId: string }) => {
      expect(input.peerId).toBe("D123");
      expect(input.trigger.content).toBe("hello from Discord");
      return { status: "completed", runId: "discord-run" };
    }) } as never;
    const manager = new ChannelRuntimeManager({ db: runtimeDb(), chatTurns, getAppConfig: () => ({}), log: () => undefined, fetchImpl, WebSocketImpl: FakeWebSocket as never });
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
    const db = {
      prepare(sql: string) {
        return {
          get() {
            if (sql.includes("SELECT id FROM chat_messages")) return undefined;
            if (sql.includes("SELECT id,content FROM chat_messages")) return { id: "assistant-1", content: "Hello from Miki" };
            return undefined;
          },
        };
      },
    } as never;
    const chatTurns = { run: jest.fn(async (input: { trigger: { content: string; clientMessageId?: string }; peerId: string }) => {
      expect(input.peerId).toBe("123");
      expect(input.trigger.content).toBe("hello");
      expect(input.trigger.clientMessageId).toBe("telegram_102");
      return { status: "completed", runId: "run-1" };
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
