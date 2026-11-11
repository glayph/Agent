import Database from "better-sqlite3";
import { GoalStore } from "../api/goals-router.js";
import { AutonomousSupervisor, parseAuditVerdict } from "./autonomous-supervisor.js";
import { ToolRegistry } from "../engine/tool-registry.js";

function makeTools() {
  const registry = new ToolRegistry();
  for (const name of ["workspace_list", "file_info", "file_read", "workspace_search", "memory_search", "memory_add", "goal_status", "file_mkdir", "file_write"]) {
    registry.register({ name, description: name, risk: "read", parameters: { type: "object", properties: {} }, approval: "auto", execute: async () => ({ ok: true }) });
  }
  return registry;
}

function makeResult(finalText: string) {
  return {
    runId: "test-run", status: "completed", model: "test-model", goal: "test goal", finalText, subtasks: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
  } as const;
}

const SATISFIED = '{"verdict":"satisfied","missing":""}';
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

describe("parseAuditVerdict", () => {
  it("reads strict JSON, fenced JSON and JSON inside prose", () => {
    expect(parseAuditVerdict(SATISFIED)).toEqual({ satisfied: true, missing: "" });
    expect(parseAuditVerdict('```json\n{"verdict":"unsatisfied","missing":"no message sent"}\n```')).toEqual({ satisfied: false, missing: "no message sent" });
    expect(parseAuditVerdict('Verdict: {"verdict":"Unsatisfied"} thanks')?.satisfied).toBe(false);
  });
  it("returns null for anything unreadable so the caller can ask again", () => {
    expect(parseAuditVerdict("looks good to me")).toBeNull();
    expect(parseAuditVerdict('{"verdict":"maybe"}')).toBeNull();
    expect(parseAuditVerdict("{not json}")).toBeNull();
  });
});

describe("AutonomousSupervisor second check, next-step goals and user-request audit", () => {
  let db: Database.Database;
  let goals: GoalStore;
  let run: jest.Mock;
  let logs: string[];
  let supervisor: AutonomousSupervisor;
  let config: Record<string, any>;

  beforeEach(() => {
    db = new Database(":memory:");
    goals = new GoalStore(db);
    run = jest.fn().mockResolvedValue(makeResult("done"));
    logs = [];
    config = {
      autonomy: { enabled: true, tool_policy: { require_acceptance_contract: false } },
      heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 }, proactive: { enabled: true, decision_interval_seconds: 100 } },
    };
    supervisor = new AutonomousSupervisor({
      db, agent: { run }, tools: makeTools(), activeRunCount: () => 0,
      getConfig: () => config, log: (message) => logs.push(message), now: () => new Date().toISOString(),
    });
  });
  afterEach(() => db.close());

  describe("goal completion is checked twice", () => {
    it("does not close a goal the independent re-check finds unsatisfied; it re-plans with what is missing", async () => {
      const goal = goals.create({ title: "Send the report to the owner", replaceExisting: false });
      run.mockResolvedValueOnce(makeResult("I sent the report."));
      run.mockResolvedValueOnce(makeResult('{"verdict":"unsatisfied","missing":"No message delivery is evidenced."}'));
      const result = await supervisor.tick("test");
      expect(result.status).toBe("idle");
      expect(goals.get(goal.id)?.status).toBe("pending");
      const row = db.prepare("SELECT status,acceptance_result FROM autonomy_goal_runs WHERE goal_id=?").get(goal.id) as { status: string; acceptance_result: string };
      expect(row.status).toBe("retry_wait");
      const acceptance = JSON.parse(row.acceptance_result);
      expect(acceptance.passed).toBe(false);
      expect(acceptance.checks).toContainEqual({ type: "llm_second_check", passed: false, detail: "No message delivery is evidenced." });
      const replan = db.prepare("SELECT instruction FROM autonomy_goal_replans WHERE goal_id=?").get(goal.id) as { instruction: string };
      expect(replan.instruction).toContain("SECOND-PASS VERIFICATION FAILED");
      expect(replan.instruction).toContain("No message delivery is evidenced.");
      expect(db.prepare("SELECT COUNT(*) c FROM pursue_goals WHERE source='next_step'").get()).toEqual({ c: 0 });
    });

    it("runs the re-check as a tool-less call at the fixed 3 s retry that also waits out quota/key blocks", async () => {
      goals.create({ title: "Write notes", replaceExisting: false });
      run.mockResolvedValueOnce(makeResult("Notes written."));
      run.mockResolvedValueOnce(makeResult(SATISFIED));
      await supervisor.tick("test");
      expect(run).toHaveBeenCalledTimes(2);
      const audit = run.mock.calls[1][0];
      expect(String(audit.runId)).toMatch(/^autonomy-audit-/);
      expect(audit.allowTools).toBe(false);
      expect(audit.tools.names()).toEqual([]);
      expect(audit.retryTransient).toMatchObject({ continueRetryingEveryMs: 3000, maxRetries: 0, jitter: false, retryPermanentFailures: true });
      expect(String(audit.goal)).toContain("Write notes");
    });

    it("uses double_check_model when a stronger independent auditor is configured", async () => {
      config.heartbeat.proactive.double_check_model = "cloud/auditor-model"
      goals.create({ title: "Audit with stronger model", replaceExisting: false })
      run.mockResolvedValueOnce(makeResult("Work done."))
      run.mockResolvedValueOnce(makeResult(SATISFIED))
      await supervisor.tick("test")
      expect(run.mock.calls[1][0].model).toBe("cloud/auditor-model")
    })

    it("completes the goal when the re-check is satisfied, and queues a goal that plans the owner's next step", async () => {
      const goal = goals.create({ title: "Prepare the invoice", replaceExisting: false });
      run.mockResolvedValueOnce(makeResult("Invoice prepared."));
      run.mockResolvedValueOnce(makeResult(SATISFIED));
      const result = await supervisor.tick("test");
      expect(result.status).toBe("completed");
      expect(goals.get(goal.id)?.status).toBe("completed");
      const next = db.prepare("SELECT * FROM pursue_goals WHERE source='next_step'").all() as Array<{ id: number; title: string; priority: number; status: string; description: string; acceptance_contract: string }>;
      expect(next).toHaveLength(1);
      expect(next[0].title).toContain(`Next step after #${goal.id}`);
      expect(next[0].priority).toBe(9);
      expect(next[0].description).toContain("what the OWNER should do next");
      const contract = JSON.parse(next[0].acceptance_contract);
      expect(contract.checks.map((c: { type: string }) => c.type)).toEqual(["file_exists", "file_contains"]);
    });

    it("never chains: a next-step goal, scheduler or curiosity goal does not spawn another", () => {
      for (const source of ["next_step", "scheduler", "curiosity", "drive", "bootstrap"]) {
        (supervisor as any).queueNextStepGoal({ id: 7, title: "x", source }, "outcome");
      }
      expect(db.prepare("SELECT COUNT(*) c FROM pursue_goals").get()).toEqual({ c: 0 });
      (supervisor as any).queueNextStepGoal({ id: 7, title: "x", source: "ambient_proposal" }, "outcome");
      (supervisor as any).queueNextStepGoal({ id: 7, title: "x", source: "ambient_proposal" }, "outcome");
      expect(db.prepare("SELECT COUNT(*) c FROM pursue_goals WHERE source='next_step'").get()).toEqual({ c: 1 });
    });

    it("asks the auditor once more on an unreadable verdict, then lets the deterministic result stand instead of hanging the goal", async () => {
      const goal = goals.create({ title: "Tidy workspace", replaceExisting: false });
      run.mockResolvedValue(makeResult("looks fine to me"));
      const result = await supervisor.tick("test");
      expect(result.status).toBe("completed");
      expect(goals.get(goal.id)?.status).toBe("completed");
      expect(run).toHaveBeenCalledTimes(3);
      expect(logs.some((line) => line.includes("no usable verdict"))).toBe(true);
    });

    it("can be switched off", async () => {
      config.heartbeat.proactive.double_check = false;
      config.heartbeat.proactive.next_step_goals = false;
      goals.create({ title: "Quick job", replaceExisting: false });
      const result = await supervisor.tick("test");
      expect(result.status).toBe("completed");
      expect(run).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT COUNT(*) c FROM pursue_goals WHERE source='next_step'").get()).toEqual({ c: 0 });
    });
  });

  describe("recent user requests are re-audited and reopened when unfinished", () => {
    const decide = () => { (supervisor as any).ambientLastAt = 0; return (supervisor as any).runAmbientDecision("idle") as Promise<boolean>; };
    const promptOf = (index: number) => String((run.mock.calls[index][0] as { goal: string }).goal);

    beforeEach(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT);
        CREATE TABLE IF NOT EXISTS memory_chunks (id TEXT PRIMARY KEY, region TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      `);
      db.prepare("INSERT INTO memory_chunks(id, region, content, summary, created_at, updated_at) VALUES('seed','long_term','seed','seed','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
      const insert = db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,status) VALUES(?,?,?,?,?,?)");
      insert.run("u1", "s1", "user", "Create three config files for the staging server", iso(-120_000), "completed");
      insert.run("a1", "s1", "assistant", "Done, I created the config files.", iso(-110_000), null);
    });

    it("lists the answered request for audit, then turns an unfinished one into a high-priority goal", async () => {
      run.mockImplementation(async (request: { tools: ToolRegistry }) => {
        const reopen = request.tools.get("autonomy_reopen_user_request");
        expect(reopen).toBeDefined();
        await reopen!.execute({ message_id: "u1", missing: "Only one of the three config files exists." }, {} as never);
        return makeResult("Reviewed the request.");
      });
      await decide();
      expect(promptOf(0)).toContain("USER REQUEST AUDIT");
      expect(promptOf(0)).toContain("[message_id=u1]");
      expect(promptOf(0)).toContain("Create three config files for the staging server");
      const reopened = db.prepare("SELECT * FROM pursue_goals WHERE source='user_request_audit'").all() as Array<{ title: string; priority: number; status: string; description: string; context: string }>;
      expect(reopened).toHaveLength(1);
      expect(reopened[0].priority).toBe(3);
      expect(reopened[0].title).toContain("Finish user request");
      expect(reopened[0].description).toContain("Only one of the three config files exists.");
      expect(JSON.parse(reopened[0].context)).toEqual({ message_id: "u1" });
      expect(db.prepare("SELECT passes,reopened,last_verdict FROM autonomy_request_audits WHERE message_id='u1'").get()).toEqual({ passes: 0, reopened: 1, last_verdict: "reopened" });
    });

    it("does not stack a second goal while the first is still open for the same request", async () => {
      run.mockImplementation(async (request: { tools: ToolRegistry }) => {
        await request.tools.get("autonomy_reopen_user_request")!.execute({ message_id: "u1", missing: "Config files are missing." }, {} as never);
        return makeResult("Reviewed.");
      });
      await decide();
      await decide();
      expect(db.prepare("SELECT COUNT(*) c FROM pursue_goals WHERE source='user_request_audit'").get()).toEqual({ c: 1 });
    });

    it("rejects a message id that is not one of the listed requests", async () => {
      let message = "";
      run.mockImplementation(async (request: { tools: ToolRegistry }) => {
        try { await request.tools.get("autonomy_reopen_user_request")!.execute({ message_id: "nope", missing: "Anything missing." }, {} as never); } catch (error) { message = String((error as Error).message); }
        return makeResult("Reviewed.");
      });
      await decide();
      expect(message).toContain("must be one of the listed user requests");
      expect(db.prepare("SELECT COUNT(*) c FROM pursue_goals WHERE source='user_request_audit'").get()).toEqual({ c: 0 });
    });

    it("checks a completed request exactly twice and then stops listing it", async () => {
      run.mockResolvedValue(makeResult("Everything the owner asked for was delivered."));
      await decide();
      await decide();
      await decide();
      expect(run).toHaveBeenCalledTimes(3);
      expect(promptOf(0)).toContain("USER REQUEST AUDIT");
      expect(promptOf(1)).toContain("USER REQUEST AUDIT");
      expect(promptOf(2)).not.toContain("USER REQUEST AUDIT");
      expect(promptOf(2)).toContain("ALREADY been answered");
      expect(db.prepare("SELECT passes FROM autonomy_request_audits WHERE message_id='u1'").get()).toEqual({ passes: 2 });
      expect(db.prepare("SELECT COUNT(*) c FROM pursue_goals").get()).toEqual({ c: 0 });
    });

    it("can be switched off", async () => {
      config.heartbeat.proactive.user_request_audit = false;
      await decide();
      expect(promptOf(0)).not.toContain("USER REQUEST AUDIT");
    });
  });

  describe("a stuck foreground request cannot silence the agent forever", () => {
    beforeEach(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT);
        CREATE TABLE IF NOT EXISTS memory_chunks (id TEXT PRIMARY KEY, region TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      `);
      db.prepare("INSERT INTO memory_chunks(id, region, content, summary, created_at, updated_at) VALUES('seed','long_term','seed','seed','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,status) VALUES('stuck','s1','user','please do the thing',?, 'processing')").run(iso(-20 * 60_000));
    });
    const decide = () => { (supervisor as any).ambientLastAt = 0; return (supervisor as any).runAmbientDecision("idle") as Promise<boolean>; };

    it("releases a hold older than foreground_hold_max_seconds when no run is alive", async () => {
      await decide();
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("still holds a fresh pending request, and holds forever only when the limit is set to 0", async () => {
      db.prepare("UPDATE chat_messages SET created_at=? WHERE id='stuck'").run(iso(-30_000));
      await decide();
      expect(run).not.toHaveBeenCalled();
      db.prepare("UPDATE chat_messages SET created_at=? WHERE id='stuck'").run(iso(-20 * 60_000));
      config.heartbeat.proactive.foreground_hold_max_seconds = 0;
      await decide();
      expect(run).not.toHaveBeenCalled();
    });
  });
});
