import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoalStore } from "../api/goals-router.js";
import { AgentEngine } from "../engine/agent-engine.js";
import { ToolRegistry } from "../engine/tool-registry.js";
import { scriptedLLM, type ScriptedReply } from "../engine/__tests__/scripted-llm.js";
import { AutonomousSupervisor } from "./autonomous-supervisor.js";
import { getPermissionLedger } from "../permissions/permission-ledger.js";

// The learned-rule ledger is a process-wide singleton; keep its file out of the repository.
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-autonomy-rules-"));
process.env.MIKI_PERMISSIONS_FILE = path.join(ledgerDir, "learned-rules.json");

const TOOL_NAMES = ["workspace_list", "file_info", "file_read", "workspace_search", "memory_search", "memory_add", "goal_status", "file_mkdir", "file_write", "terminal_run"];

function makeTools(executed: string[]) {
  const registry = new ToolRegistry();
  for (const name of TOOL_NAMES) {
    registry.register({
      name,
      description: name,
      risk: "read",
      parameters: { type: "object", properties: {} },
      approval: "auto",
      execute: async () => {
        executed.push(name);
        return { ok: true };
      },
    });
  }
  return registry;
}

function harness(replies: ScriptedReply[], configOverride: Record<string, unknown> = {}) {
  const db = new Database(":memory:");
  const goals = new GoalStore(db);
  const executed: string[] = [];
  const notices: Array<{ text?: string; event?: Record<string, unknown>; kind?: string }> = [];
  const llm = scriptedLLM(replies);
  // Same engine options the gateway uses for autonomous runs (turbo mode: no interactive approval prompts).
  const engine = new AgentEngine({ llm: llm.client, tools: new ToolRegistry(), turboMode: true });
  const config: Record<string, unknown> = {
    autonomy: { enabled: true, unlimited_budgets: true, tool_policy: { max_retries: 0, retry_backoff_seconds: 5 } },
    heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } },
    ...configOverride,
  };
  const supervisor = new AutonomousSupervisor({
    db,
    agent: engine,
    tools: makeTools(executed),
    activeRunCount: () => 0,
    getConfig: () => config,
    log: () => undefined,
    notify: (input) => { notices.push(input); },
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const expireRetry = (goalId: number) => {
    db.prepare("UPDATE autonomy_goal_runs SET next_retry_at=? WHERE goal_id=?").run("2000-01-01T00:00:00.000Z", goalId);
  };
  return { db, goals, supervisor, executed, notices, llm, expireRetry, close: () => db.close() };
}

const gateNotices = (notices: Array<{ event?: Record<string, unknown> }>) => notices.filter((n) => n.event?.type === "approval_gate_blocked");

describe("autonomy rules: no routine confirmation, notices, endless goals", () => {
  afterEach(() => {
    getPermissionLedger().forget("shell");
  });

  it("(a) an assigned goal runs its tools without a confirmation prompt and completes", async () => {
    const h = harness([
      { calls: [{ name: "file_read", args: { path: "notes.txt" } }] },
      { text: "The notes were read." },
    ]);
    const goal = h.goals.create({ title: "Read notes", steps: ["Read"], replaceExisting: false });

    const result = await h.supervisor.tick("test");

    expect(result.status).toBe("completed");
    expect(h.goals.get(goal.id)?.status).toBe("completed");
    expect(h.executed).toEqual(["file_read"]);
    expect(gateNotices(h.notices)).toHaveLength(0);
    h.close();
  });

  it("(b) a notice is sent once when an approval gate stops a call, and the cycle still completes", async () => {
    getPermissionLedger().learn({ category: "shell", decision: "ask", note: "ask me before any shell command" });
    const h = harness([
      { calls: [{ name: "terminal_run", args: { command: "echo first" } }] },
      { calls: [{ name: "terminal_run", args: { command: "echo second" } }] },
      { text: "The shell step needs your approval, so I stopped there." },
    ]);
    const goal = h.goals.create({ title: "Run a command", steps: ["Run"], replaceExisting: false });

    const result = await h.supervisor.tick("test");

    expect(result.status).toBe("completed");
    expect(h.goals.get(goal.id)?.status).toBe("completed");
    const notes = gateNotices(h.notices);
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("warning");
    expect(notes[0].event).toMatchObject({ tool: "terminal_run" });
    h.close();
  });

  it("(d) a call that reaches a learned approval gate is still blocked and never executed", async () => {
    getPermissionLedger().learn({ category: "shell", decision: "ask", note: "ask me before any shell command" });
    const h = harness([
      { calls: [{ name: "terminal_run", args: { command: "rm -rf /tmp/example" } }] },
      { text: "I did not run the command because it needs your approval." },
    ]);
    h.goals.create({ title: "Clean up", steps: ["Clean"], replaceExisting: false });

    await h.supervisor.tick("test");

    expect(h.executed).not.toContain("terminal_run");
    h.close();
  });

  it("(e) a goal runs past the former retry cap until it is complete", async () => {
    const h = harness([
      { text: "BLOCKED: waiting for the first input." },
      { text: "BLOCKED: waiting for the second input." },
      { text: "BLOCKED: waiting for the third input." },
      { text: "All inputs were handled." },
    ]);
    const goal = h.goals.create({ title: "Long goal", steps: ["Work"], replaceExisting: false });

    // With max_retries 0 the old cap would have blocked the goal after its first failed attempt.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await h.supervisor.tick("retry")).status).toBe("idle");
      expect(h.goals.get(goal.id)?.status).toBe("active");
      h.expireRetry(goal.id);
    }
    expect((await h.supervisor.tick("retry")).status).toBe("completed");
    expect(h.goals.get(goal.id)?.status).toBe("completed");
    h.close();
  });

  it("(e) the user's Stop ends a goal that is still retrying", async () => {
    const h = harness([{ text: "BLOCKED: waiting for input." }]);
    const goal = h.goals.create({ title: "Stoppable goal", steps: ["Work"], replaceExisting: false });
    expect((await h.supervisor.tick("retry")).status).toBe("idle");
    const requestsBeforeStop = h.llm.requests.length;

    h.goals.update(goal.id, { status: "cancelled", statusReason: "Stopped by the user." });
    h.expireRetry(goal.id);
    const afterStop = await h.supervisor.tick("retry");

    expect(afterStop.status).toBe("idle");
    expect(h.llm.requests.length).toBe(requestsBeforeStop);
    expect(h.goals.get(goal.id)?.status).toBe("cancelled");
    h.close();
  });

  it("removes the retry cap whatever unlimited_budgets says", async () => {
    const h = harness(
      [{ text: "BLOCKED: waiting for input." }],
      { autonomy: { enabled: true, tool_policy: { max_retries: 0, retry_backoff_seconds: 5 } } },
    );
    const goal = h.goals.create({ title: "Uncapped goal", steps: ["Work"], replaceExisting: false });
    expect((await h.supervisor.tick("retry")).status).toBe("idle");
    expect(h.goals.get(goal.id)?.status).toBe("active");
    h.close();
  });

  it("reports the unlimited retry setting in status", () => {
    const h = harness([{ text: "unused" }]);
    expect(h.supervisor.status().retry).toMatchObject({ max_retries: null, unlimited: true });
    h.close();
  });
});
