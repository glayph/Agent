import { AgentEngine } from "./agent-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { buildEvidence, parseVerdict, verifyAnswer } from "./verifier.js";
import { scriptedLLM } from "./__tests__/scripted-llm.js";
import type { EngineMessage, EngineTool } from "./types.js";

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
/** Requests the run itself made; the separate "did the agent finish?" completion check is not counted. */
const modelRequests = (llm: { requests: Array<{ messages: EngineMessage[] }> }) =>
  llm.requests.filter((request) => !String(request.messages[0]?.content).includes("You classify whether the agent has completed"));

describe("parseVerdict", () => {
  it("reads a verdict wrapped in prose or fences", () => {
    expect(parseVerdict('```json\n{"ok":false,"issues":["claims a file was saved but the write failed"]}\n```')).toEqual({
      ok: false,
      issues: ["claims a file was saved but the write failed"],
    });
    expect(parseVerdict('{"ok":true,"issues":["ignored"]}')).toEqual({ ok: true, issues: [] });
  });

  it("treats a not-ok verdict without a concrete issue as ok, and junk as unknown", () => {
    expect(parseVerdict('{"ok":false,"issues":[]}')).toEqual({ ok: true, issues: [] });
    expect(parseVerdict("looks fine to me")).toBeNull();
    expect(parseVerdict('{"verdict":"ok"}')).toBeNull();
  });
});

describe("buildEvidence", () => {
  it("keeps the newest tool outputs, trimmed", () => {
    const messages = [
      { role: "user" as const, content: "q" },
      { role: "tool" as const, name: "a", toolCallId: "1", content: "first" },
      { role: "tool" as const, name: "b", toolCallId: "2", content: "x".repeat(50) },
    ];
    const evidence = buildEvidence(messages, 1, 10);
    expect(evidence).toContain("[b]");
    expect(evidence).not.toContain("[a]");
    expect(evidence).toContain("truncated");
  });
});

describe("verifyAnswer", () => {
  it("returns null instead of throwing when the check cannot run", async () => {
    const reasons: string[] = [];
    const llm = { model: "m", complete: async () => { throw new Error("offline"); } } as never;
    expect(await verifyAnswer({ llm, goal: "g", answer: "a", messages: [], onError: (r) => reasons.push(r) })).toBeNull();
    expect(reasons).toEqual(["offline"]);
  });
});

describe("engine self-check", () => {
  const registry = () => {
    const r = new ToolRegistry();
    r.register(tool({ name: "write_note", execute: async () => ({ ok: false, error: "disk full" }) }));
    return r;
  };

  it("revises once when the verifier finds a concrete problem", async () => {
    const llm = scriptedLLM([
      { calls: [{ name: "write_note", args: {} }] },
      { text: "Saved the note." },
      { text: '{"ok":false,"issues":["The write failed with disk full but the answer says it was saved."]}' },
      { text: "I could not save the note: the disk is full." },
    ]);
    const events: string[] = [];
    const engine = new AgentEngine({ llm: llm.client, tools: registry(), selfCheck: {} });
    const result = await engine.run({ history: user("save a note"), onEvent: (e) => events.push(e.type) });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("I could not save the note: the disk is full.");
    expect(events.filter((type) => type === "message.final")).toHaveLength(1);
    const revisionPrompt = llm.requests[3].messages.at(-1);
    expect(String(revisionPrompt?.content)).toContain("disk full");
  });

  it("accepts the draft when the verifier agrees, and never revises more than allowed", async () => {
    const accepted = scriptedLLM([
      { calls: [{ name: "write_note", args: {} }] },
      { text: "The write failed: disk full." },
      { text: '{"ok":true,"issues":[]}' },
    ]);
    const first = await new AgentEngine({ llm: accepted.client, tools: registry(), selfCheck: {} }).run({ history: user("save a note") });
    expect(first.finalText).toBe("The write failed: disk full.");

    const stubborn = scriptedLLM([
      { calls: [{ name: "write_note", args: {} }] },
      { text: "draft one" },
      { text: '{"ok":false,"issues":["problem"]}' },
      { text: "draft two" },
    ]);
    const second = await new AgentEngine({ llm: stubborn.client, tools: registry(), selfCheck: { maxRevisions: 1 } }).run({ history: user("save a note") });
    expect(second.finalText).toBe("draft two");
    expect(modelRequests(stubborn)).toHaveLength(4);
  });

  it("skips the check for chat-only runs and when disabled", async () => {
    const chat = scriptedLLM([{ text: "hello" }]);
    await new AgentEngine({ llm: chat.client, tools: registry(), selfCheck: {} }).run({ history: user("hi") });
    expect(modelRequests(chat)).toHaveLength(1);

    const off = scriptedLLM([{ calls: [{ name: "write_note", args: {} }] }, { text: "done" }]);
    await new AgentEngine({ llm: off.client, tools: registry(), selfCheck: () => false }).run({ history: user("go") });
    expect(modelRequests(off)).toHaveLength(2);
  });

  it("is off unless the host enables it", async () => {
    const llm = scriptedLLM([{ calls: [{ name: "write_note", args: {} }] }, { text: "done" }]);
    await new AgentEngine({ llm: llm.client, tools: registry() }).run({ history: user("go") });
    expect(modelRequests(llm)).toHaveLength(2);
  });
});
