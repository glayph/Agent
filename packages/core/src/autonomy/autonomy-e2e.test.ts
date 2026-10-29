import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentEngine } from "../engine/agent-engine.js";
import { ToolRegistry } from "../engine/tool-registry.js";
import type { EngineMessage } from "../engine/types.js";
import { scriptedLLM, type ScriptedReply } from "../engine/__tests__/scripted-llm.js";
import { AutonomousSupervisor } from "./autonomous-supervisor.js";

/**
 * End-to-end: real AgentEngine + real AutonomousSupervisor loop + real SQLite.
 * Only the LLM is scripted. Nothing here sends a user message to start work.
 */

const AMBIENT_MARKER = "running the background autonomous loop";
const isAmbient = (messages: EngineMessage[]) =>
  messages.some((m) => typeof m.content === "string" && m.content.includes(AMBIENT_MARKER));

/** Requests the agent made itself; the separate "did the agent finish?" completion check is not counted. */
const agentRequests = (llm: { requests: Array<{ messages: EngineMessage[] }> }) =>
  llm.requests.filter((request) => !String(request.messages[0]?.content).includes("You classify whether the agent has completed"));

async function waitFor(condition: () => boolean, timeoutMs = 4000, stepMs = 10) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function setup(script: ScriptedReply[], configGuard?: () => void) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-e2e-"));
  fs.mkdirSync(path.join(workspace, "identity"));
  fs.writeFileSync(path.join(workspace, "identity", "HEARTBEAT.md"), "- [notify] Report workspace entries\n");

  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE memory_chunks (id TEXT PRIMARY KEY, region TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES('m0','miki-main-chat','user','Remember: watch the workspace for me.','2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO memory_chunks(id,region,content,summary,importance,created_at,updated_at) VALUES('c0','prefs','User wants workspace reports','workspace reports',0.9,'2026-01-01','2026-01-01')").run();

  const toolRuns: Array<Record<string, unknown>> = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "workspace_list",
    description: "List workspace entries",
    risk: "read",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    approval: "auto",
    execute: (input: Record<string, unknown>) => { toolRuns.push(input); return { entries: ["notes.txt"] }; },
  });

  const llm = scriptedLLM(script);
  const engine = new AgentEngine({ llm: llm.client, tools: registry });
  const notifications: Array<{ text?: string; kind?: string }> = [];
  const logs: string[] = [];
  const config = {
    autonomy: { enabled: true },
    heartbeat: {
      enabled: true,
      auto_actions: { enabled: true, max_actions_per_cycle: 2 },
      proactive: { enabled: true, llm_when_idle: true, startup_decision: true, min_poll_seconds: 5, max_poll_seconds: 10, decision_interval_seconds: 900 },
    },
  };
  const supervisor = new AutonomousSupervisor({
    db,
    agent: engine,
    tools: registry,
    getConfig: () => { configGuard?.(); return config; },
    log: (message) => logs.push(message),
    notify: (n) => { notifications.push(n); },
    workspaceRoot: workspace,
  });
  return { supervisor, engine, llm, db, toolRuns, notifications, logs, workspace };
}

describe("autonomy end-to-end (scripted LLM, no user message)", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!();
  });
  const track = (ctx: ReturnType<typeof setup>) => {
    cleanup.push(async () => { await ctx.supervisor.stop(); ctx.db.close(); fs.rmSync(ctx.workspace, { recursive: true, force: true }); });
    return ctx;
  };

  it("starts by itself, loads context and runs a tool; inline work is logged, not broadcast", async () => {
    const ctx = track(setup([
      { calls: [{ name: "workspace_list", args: {} }] },
      { text: "Workspace check done: 1 entry (notes.txt)." },
    ]));

    ctx.supervisor.start();
    await waitFor(() => ctx.logs.some((line) => line.includes("finished inline work")));
    expect(ctx.toolRuns).toHaveLength(1);
    expect(ctx.notifications).toHaveLength(0); // routine inline work is never routine chatter

    // The ambient prompt carried everything the agent needs to decide on its own.
    const prompt = ctx.llm.requests[0].messages.map((m) => String(m.content)).join("\n");
    expect(prompt).toContain("Trigger: startup");
    expect(prompt).toContain("Report workspace entries");
    expect(prompt).toContain("workspace reports");
    expect(prompt).toContain("watch the workspace for me");
  });

  it("stays silent and does not re-ask the LLM when woken by events (fixed interval)", async () => {
    const ctx = track(setup([{ text: "Reviewed the workspace notes." }]));

    ctx.supervisor.start();
    await waitFor(() => agentRequests(ctx.llm).length === 1);
    await waitFor(() => ctx.logs.some((line) => line.includes("finished inline work")));
    expect(ctx.notifications).toHaveLength(0);

    for (let i = 0; i < 5; i += 1) ctx.supervisor.wake(); // simulated incoming/outgoing messages
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(agentRequests(ctx.llm)).toHaveLength(1);
    expect(ctx.supervisor.status().proactive_loop.next_decision_in_seconds).toBeGreaterThan(0);
  });

  it("answers a foreground chat message instantly while a background decision is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const script: ScriptedReply[] = [
      async (messages) => {
        if (isAmbient(messages)) {
          await gate; // background work is "thinking"
          return { text: "Background research finished: found 3 sources." };
        }
        return { text: "pong" };
      },
    ];
    const ctx = track(setup(script));

    ctx.supervisor.start();
    await waitFor(() => ctx.llm.requests.some((r) => isAmbient(r.messages)));

    const foreground = await ctx.engine.run({ history: [{ role: "user", content: "ping" }] });
    expect(foreground.status).toBe("completed");
    expect(foreground.finalText).toBe("pong");
    expect(ctx.notifications).toHaveLength(0); // background still pending, not killed

    release();
    await waitFor(() => ctx.logs.some((line) => line.includes("finished inline work")));
    expect(ctx.notifications).toHaveLength(0); // the result is logged; the user hears about it via goals/discoveries
  });

  it("materializes a scheduled (cron/interval) task on time even while a long idle decision is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ctx = track(setup([async (messages) => { if (isAmbient(messages)) await gate; return { text: "Done thinking." }; }]));

    ctx.supervisor.start();
    await waitFor(() => ctx.llm.requests.some((r) => isAmbient(r.messages)));
    expect(ctx.logs.some((line) => line.includes("finished inline work"))).toBe(false); // the idle decision is still in flight

    const task = ctx.supervisor.enqueueTask({ title: "Scheduled report", dueAt: new Date(Date.now() + 1500).toISOString() });
    expect(task).toBeTruthy();
    // The idle LLM call has not returned; the loop must still tick, find the due task and turn it into a goal.
    try {
      // The loop polls every min_poll_seconds (5s here); the LLM call is still hanging, yet the due task must be picked up.
      await waitFor(() => (ctx.db.prepare("SELECT COUNT(*) c FROM pursue_goals WHERE title LIKE '%Scheduled report%'").get() as { c: number }).c > 0, 12_000);
      expect(ctx.logs.some((line) => line.includes("finished inline work"))).toBe(false);
    } finally {
      release();
    }
  }, 20_000);

  it("shuts down promptly on stop() even while a background LLM call is in flight", async () => {
    const script: ScriptedReply[] = [
      (messages, options) => new Promise((resolve, reject) => {
        if (!isAmbient(messages)) return resolve({ text: "unused" });
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ];
    const ctx = track(setup(script));

    ctx.supervisor.start();
    await waitFor(() => ctx.llm.requests.length === 1);

    const started = Date.now();
    await ctx.supervisor.stop();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ctx.notifications).toHaveLength(0);
  });

  it("treats a failing model as an outage: no spam, no false 'nothing to do', no crash", async () => {
    const ctx = track(setup([{ error: "Model provider returned HTTP 429" }]));

    ctx.supervisor.start();
    await waitFor(() => ctx.supervisor.status().proactive_loop.failure_streak === 1);
    expect(ctx.supervisor.status().proactive_loop).toMatchObject({
      last_failure: expect.objectContaining({ kind: "rate_limit" }),
    });

    for (let i = 0; i < 5; i += 1) ctx.supervisor.wake();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ctx.llm.requests).toHaveLength(1); // exponential backoff, not a retry storm
    expect(ctx.notifications).toHaveLength(0); // below the circuit threshold
  });

  it("keeps the loop alive when the config reader throws, and resumes when it recovers", async () => {
    let broken = true;
    const ctx = track(setup([{ text: "Checked in on the workspace." }], () => { if (broken) throw new Error("agent.yaml is mid-write"); }));

    ctx.supervisor.start(); // must not throw
    await waitFor(() => ctx.logs.some((line) => line.includes("iteration failed")));
    expect(ctx.llm.requests).toHaveLength(0);

    broken = false;
    ctx.supervisor.wake();
    await waitFor(() => agentRequests(ctx.llm).length === 1);
    expect(ctx.logs.some((line) => line.includes("stopped unexpectedly"))).toBe(false);
  });
});
