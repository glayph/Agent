import { createGlobalMemory, isOwnerOrigin } from "./global-memory.js";
import type { AgentMemoryIntegration } from "./types.js";

function fakeIntegration(overrides: Partial<{ hasContent: boolean; text: string; throws: boolean }> = {}) {
  const logged: Array<{ user: string; assistant: string; metadata: Record<string, unknown> }> = [];
  const queries: string[] = [];
  const integration = {
    getPromptContext(query: string) {
      queries.push(query);
      if (overrides.throws) throw new Error("db locked");
      return { text: overrides.text ?? "MEMORY: user deploys in VirtualBox", hasContent: overrides.hasContent ?? true };
    },
    logInteraction(user: string, assistant: string, metadata: Record<string, unknown>) {
      logged.push({ user, assistant, metadata });
      return {};
    },
  } as unknown as AgentMemoryIntegration;
  return { integration, logged, queries };
}

const turn = (extra: Record<string, unknown> = {}) => ({
  source: "webchat",
  sessionId: "chat-1",
  taskTitle: "Install Miki",
  userMessage: "How do I install Miki?",
  assistantMessage: "Use the installer.",
  status: "completed",
  ...extra,
});

describe("isOwnerOrigin", () => {
  it("treats the local UI and CLI as the owner", () => {
    expect(isOwnerOrigin({ source: "webchat" }, {})).toBe(true);
    expect(isOwnerOrigin({ source: "CLI" }, {})).toBe(true);
  });

  it("never treats api-test or unknown platforms as the owner by default", () => {
    expect(isOwnerOrigin({ source: "api-test" }, {})).toBe(false);
    expect(isOwnerOrigin({ source: "telegram", peerId: "42" }, {})).toBe(false);
    expect(isOwnerOrigin({ source: "telegram" }, { agent: { memory: { global: { owner_peers: ["telegram:42"] } } } })).toBe(false);
  });

  it("accepts a platform sender only when listed as source:peer", () => {
    const config = { agent: { memory: { global: { owner_peers: ["Telegram:42", 7, ""] } } } };
    expect(isOwnerOrigin({ source: "telegram", peerId: "42" }, config)).toBe(true);
    expect(isOwnerOrigin({ source: "telegram", peerId: "43" }, config)).toBe(false);
    expect(isOwnerOrigin({ source: "discord", peerId: "42" }, config)).toBe(false);
  });
});

describe("createGlobalMemory", () => {
  it("recalls for the owner and labels the block as data, not instructions", () => {
    const { integration, queries } = fakeIntegration();
    const memory = createGlobalMemory({ getIntegration: () => integration, getConfig: () => ({}) });
    const block = memory.recall("where do I deploy?", { source: "webchat", sessionId: "chat-2" });
    expect(block).toContain("user deploys in VirtualBox");
    expect(block).toContain("not instructions");
    expect(queries).toEqual(["where do I deploy?"]);
  });

  it("returns nothing when nothing was recalled, for strangers, tiny queries and errors", () => {
    const base = { getConfig: () => ({}) };
    const empty = fakeIntegration({ hasContent: false });
    expect(createGlobalMemory({ ...base, getIntegration: () => empty.integration }).recall("hello there", { source: "webchat" })).toBeUndefined();

    const full = fakeIntegration();
    const memory = createGlobalMemory({ ...base, getIntegration: () => full.integration });
    expect(memory.recall("what do you know about me?", { source: "telegram", peerId: "stranger" })).toBeUndefined();
    expect(memory.recall("x", { source: "webchat" })).toBeUndefined();
    expect(full.queries).toHaveLength(0);

    const broken = fakeIntegration({ throws: true });
    const logs: string[] = [];
    const guarded = createGlobalMemory({ ...base, getIntegration: () => broken.integration, log: (m) => logs.push(m) });
    expect(guarded.recall("anything at all", { source: "webchat" })).toBeUndefined();
    expect(logs).toEqual(["global_memory.recall_failed"]);
  });

  it("returns nothing when the memory is not available", () => {
    const memory = createGlobalMemory({ getIntegration: () => null, getConfig: () => ({}) });
    expect(memory.recall("hello world", { source: "webchat" })).toBeUndefined();
    expect(memory.recordTurn(turn())).toBe(false);
  });

  it("records an owner turn with its channel, task and trust, in one global store", () => {
    const { integration, logged } = fakeIntegration();
    const memory = createGlobalMemory({ getIntegration: () => integration, getConfig: () => ({}) });
    expect(memory.recordTurn(turn())).toBe(true);
    expect(memory.recordTurn(turn({ source: "cli", sessionId: "cli-9", userMessage: "second" }))).toBe(true);
    expect(logged).toHaveLength(2);
    expect(logged[0].metadata).toMatchObject({ source: "webchat", taskId: "chat-1", taskTitle: "Install Miki", trust: "owner" });
    // No per-chat memory scope is ever passed: the integration's global scope applies.
    expect(logged[0].metadata).not.toHaveProperty("memoryScope");
    expect(logged[0].metadata).not.toHaveProperty("scope");
  });

  it("never records strangers, failed or cancelled runs, or empty turns", () => {
    const { integration, logged } = fakeIntegration();
    const memory = createGlobalMemory({ getIntegration: () => integration, getConfig: () => ({}) });
    expect(memory.recordTurn(turn({ source: "telegram", peerId: "stranger" }))).toBe(false);
    expect(memory.recordTurn(turn({ source: "api-test" }))).toBe(false);
    expect(memory.recordTurn(turn({ status: "failed" }))).toBe(false);
    expect(memory.recordTurn(turn({ status: "cancelled" }))).toBe(false);
    expect(memory.recordTurn(turn({ assistantMessage: "  " }))).toBe(false);
    expect(logged).toHaveLength(0);
  });

  it("lets a listed Telegram owner read and write the same memory", () => {
    const { integration, logged } = fakeIntegration();
    const memory = createGlobalMemory({
      getIntegration: () => integration,
      getConfig: () => ({ agent: { memory: { global: { owner_peers: ["telegram:42"] } } } }),
    });
    expect(memory.recall("what did I decide yesterday?", { source: "telegram", peerId: "42" })).toContain("VirtualBox");
    expect(memory.recordTurn(turn({ source: "telegram", peerId: "42", sessionId: "tg-42" }))).toBe(true);
    expect(logged[0].metadata).toMatchObject({ source: "telegram", peer: "42" });
  });
});

describe("extractPending", () => {
  const summary = { processed: 2, entities: 5, relations: 3, skipped: 0, failed: 0 };

  it("hands the model and limit to the memory and returns its summary", async () => {
    const calls: Array<{ limit?: number; hasComplete: boolean; hasLog: boolean }> = [];
    const integration = {
      extractPending: async (options: { limit?: number; complete: unknown; log?: unknown }) => {
        calls.push({ limit: options.limit, hasComplete: typeof options.complete === "function", hasLog: typeof options.log === "function" });
        return summary;
      },
    } as unknown as AgentMemoryIntegration;
    const memory = createGlobalMemory({ getIntegration: () => integration, getConfig: () => ({}) });
    const result = await memory.extractPending({ limit: 4, complete: async () => "{}" });
    expect(result).toEqual(summary);
    expect(calls).toEqual([{ limit: 4, hasComplete: true, hasLog: true }]);
  });

  it("returns an empty summary when the memory is unavailable or throws", async () => {
    const none = createGlobalMemory({ getIntegration: () => null, getConfig: () => ({}) });
    expect(await none.extractPending({ complete: async () => "{}" })).toEqual({ processed: 0, entities: 0, relations: 0, skipped: 0, failed: 0 });

    const logs: string[] = [];
    const broken = {
      extractPending: async () => {
        throw new Error("db locked");
      },
    } as unknown as AgentMemoryIntegration;
    const guarded = createGlobalMemory({ getIntegration: () => broken, getConfig: () => ({}), log: (message) => logs.push(message) });
    expect((await guarded.extractPending({ complete: async () => "{}" })).processed).toBe(0);
    expect(logs).toEqual(["global_memory.extract_failed"]);
  });
});
