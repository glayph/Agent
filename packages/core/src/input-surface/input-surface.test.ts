import {
  channelToSurface,
  createCliAdapter,
  createDefaultSurfaceRegistry,
  createJsonSurfaceAdapter,
  createWebhookAdapter,
  ingest,
  looksLikeSessionKey,
  normalizeFromSurface,
  normalizeInboundEvent,
  parseSessionKey,
  resolveSessionKey,
  SurfaceAdapterRegistry,
  type InboundEvent,
} from "./index.js";

describe("input-surface session_key", () => {
  it("is deterministic for the same surface + conversation + role", () => {
    const a = resolveSessionKey({
      surface: "cli",
      conversationId: "conv-1",
      agentRole: "miki",
    });
    const b = resolveSessionKey({
      surface: "cli",
      conversationId: "conv-1",
      agentRole: "miki",
    });
    expect(a).toBe(b);
    expect(a).toBe("cli:conv-1:miki");
  });

  it("differs when surface, thread, or role changes", () => {
    const base = resolveSessionKey({
      surface: "webhook",
      conversationId: "t1",
      agentRole: "default",
    });
    expect(
      resolveSessionKey({
        surface: "cli",
        conversationId: "t1",
        agentRole: "default",
      }),
    ).not.toBe(base);
    expect(
      resolveSessionKey({
        surface: "webhook",
        conversationId: "t2",
        agentRole: "default",
      }),
    ).not.toBe(base);
    expect(
      resolveSessionKey({
        surface: "webhook",
        conversationId: "t1",
        agentRole: "scout",
      }),
    ).not.toBe(base);
  });

  it("parses keys it produces", () => {
    const key = resolveSessionKey({
      surface: "ide",
      threadId: "thread-9",
      agentRole: "forge",
    });
    expect(parseSessionKey(key)).toEqual({
      surface: "ide",
      thread: "thread-9",
      role: "forge",
    });
    expect(looksLikeSessionKey(key)).toBe(true);
    expect(looksLikeSessionKey("bare-id")).toBe(false);
  });

  it("promotes legacy bare sessionId into formula key", () => {
    const event = normalizeInboundEvent({
      surface: "web",
      senderId: "u1",
      session_key: "legacy-session",
    });
    expect(event.session_key).toBe("web:legacy-session:default");
  });

  it("keeps an already-formed session_key", () => {
    const event = normalizeInboundEvent({
      surface: "api",
      senderId: "svc",
      session_key: "api:thread-x:role-y",
    });
    expect(event.session_key).toBe("api:thread-x:role-y");
  });
});

describe("input-surface adapters (acceptance)", () => {
  it("CLI and fake webhook produce the same InboundEvent shape", () => {
    const cli = createCliAdapter().normalize("hello from cli", {
      senderId: "user-a",
    });
    const webhook = createWebhookAdapter().normalize(
      {
        senderId: "user-a",
        conversationId: "hook-1",
        text: "hello from webhook",
      },
      { senderId: "user-a" },
    );

    const requiredKeys: (keyof InboundEvent)[] = [
      "eventId",
      "idempotencyKey",
      "surface",
      "session_key",
      "payload",
      "timestamp",
      "sender_meta",
    ];
    for (const key of requiredKeys) {
      expect(cli[key]).toBeDefined();
      expect(webhook[key]).toBeDefined();
    }
    expect(cli.surface).toBe("cli");
    expect(webhook.surface).toBe("webhook");
    expect(cli.sender_meta.id).toBe("user-a");
    expect(webhook.sender_meta.id).toBe("user-a");
    expect(typeof cli.session_key).toBe("string");
    expect(typeof webhook.session_key).toBe("string");
    expect(cli.payload.text || cli.payload.message).toBeTruthy();
    expect(webhook.payload.text || webhook.payload.message).toBeTruthy();
    expect(cli.payload.senderId).toBeUndefined();
    expect(webhook.payload.conversationId).toBeUndefined();
  });

  it("maps legacy sessionId to conversationId (formula key)", () => {
    const event = createWebhookAdapter().normalize({
      senderId: "u",
      sessionId: "room-7",
      text: "hi",
    });
    expect(event.session_key).toBe("webhook:room-7:default");
  });

  it("adding a new surface only needs a new adapter (no core agent files)", () => {
    const registry = createDefaultSurfaceRegistry();
    const custom = createJsonSurfaceAdapter("task_api");
    registry.register({
      surface: "task_api",
      normalize(raw, ctx) {
        return custom.normalize(raw, ctx);
      },
    });
    const event = registry.normalize("task_api", {
      senderId: "worker-1",
      conversationId: "job-42",
      agentRole: "default",
      text: "run report",
    });
    expect(event.surface).toBe("task_api");
    expect(event.session_key).toBe("task_api:job-42:default");
    expect(event.payload.text).toBe("run report");
  });

  it("channelToSurface is allocation-free mapping", () => {
    expect(channelToSurface("Telegram")).toBe("telegram");
    expect(channelToSurface("unknown-x")).toBe("api");
  });

  it("rejects missing sender on generic adapter", () => {
    expect(() =>
      createJsonSurfaceAdapter("api").normalize({ text: "no sender" }),
    ).toThrow(/sender_meta\.id is required/);
  });

  it("CLI/webhook provide default sender for ergonomics", () => {
    const anon = createWebhookAdapter().normalize({
      text: "anon",
      conversationId: "c",
    });
    expect(anon.sender_meta.id).toBe("webhook");
  });
});

describe("ingest entry-point", () => {
  it("normalizes without calling a sink when none is provided", async () => {
    const result = await ingest(
      { senderId: "u1", conversationId: "c1", text: "ping" },
      "webhook",
    );
    expect(result.delivered).toBe(false);
    expect(result.event.surface).toBe("webhook");
    expect(result.event.session_key).toBe("webhook:c1:default");
  });

  it("delivers only the normalized event to the sink (never raw)", async () => {
    const seen: InboundEvent[] = [];
    const result = await ingest("do the thing", "cli", {
      senderId: "cli-user",
      sink: (event) => {
        seen.push(event);
      },
    });
    expect(result.delivered).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.surface).toBe("cli");
    expect(seen[0]!.payload.text || seen[0]!.payload.message).toContain(
      "do the thing",
    );
    expect(seen[0]).not.toBe("do the thing");
  });

  it("rejects unknown surfaces", async () => {
    await expect(ingest({ text: "x" }, "not-a-real-surface")).rejects.toThrow(
      /Unsupported surface/,
    );
  });

  it("normalizeFromSurface matches ingest event shape", () => {
    const registry = new SurfaceAdapterRegistry();
    registry.register(createCliAdapter());
    registry.register(createWebhookAdapter());
    const a = normalizeFromSurface(
      { senderId: "s", conversationId: "t", text: "hi" },
      "webhook",
      { registry },
    );
    expect(a.session_key).toBe(
      resolveSessionKey({
        surface: "webhook",
        conversationId: "t",
        agentRole: "default",
      }),
    );
  });
});
