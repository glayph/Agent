import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoalStore } from "../api/goals-router.js";
import { AutonomousSupervisor } from "./autonomous-supervisor.js";
import { ToolRegistry } from "../engine/tool-registry.js";


function makeTools() {
  const registry = new ToolRegistry();
  for (const name of ["workspace_list", "file_info", "file_read", "workspace_search", "memory_search", "memory_add", "goal_status", "file_mkdir", "file_write"]) {
    registry.register({ name, description: name, risk: "read", parameters: { type: "object", properties: {} }, approval: "auto", execute: async () => ({ ok: true }) });
  }
  return registry;
}

function makeResult(finalText = "Inspection complete.", status: "completed" | "failed" = "completed") {
  return {
    runId: "test-run",
    status,
    model: "test-model",
    goal: "test goal",
    finalText,
    subtasks: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  } as const;
}

describe("AutonomousSupervisor", () => {
  let db: Database.Database;
  let goals: GoalStore;
  let run: jest.Mock;
  let activeRunCount: jest.Mock;
  let logs: string[];
  let supervisor: AutonomousSupervisor;
  let config: Record<string, unknown>;

  beforeEach(() => {
    db = new Database(":memory:");
    goals = new GoalStore(db);
    run = jest.fn().mockResolvedValue(makeResult());
    activeRunCount = jest.fn().mockReturnValue(0);
    logs = [];
    config = { autonomy: { enabled: true }, heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } } };
    supervisor = new AutonomousSupervisor({
      db,
      agent: { run },
      tools: makeTools(),
      activeRunCount,
      getConfig: () => config,
      log: (message) => logs.push(message),
      now: () => "2026-01-01T00:00:00.000Z",
    });
  });

  afterEach(() => db.close());

  it("runs an active goal with only the safe tool allowlist and persists completion", async () => {
    const goal = goals.create({ title: "Inspect workspace", steps: ["Inspect"], replaceExisting: false });
    const result = await supervisor.tick("test");

    expect(result.status).toBe("completed");
    expect(result.goalId).toBe(goal.id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].tools.names()).toEqual([
      "workspace_list", "file_info", "file_read", "workspace_search", "memory_search", "memory_add", "goal_status", "file_mkdir", "file_write",
    ]);
    expect(run.mock.calls[0][0].approvalPolicy).toBeDefined();
    expect(run.mock.calls[0][0].maxToolCalls).toBe(1);
    expect(run.mock.calls[0][0].maxCompletionTokens).toBe(8192);
    expect(goals.get(goal.id)?.status).toBe("completed");
    expect(db.prepare("SELECT status FROM autonomy_goal_runs WHERE run_id=?").get(result.runId)).toEqual({ status: "completed" });
  });

  it("fails closed on completed model output when deterministic acceptance is required", async () => {
    config = {
      autonomy: { enabled: true, tool_policy: { require_acceptance_contract: true, max_retries: 0 } },
      heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } },
    };
    const goal = goals.create({
      title: "Verify service",
      steps: ["Verify"],
      acceptance: { checks: [{ type: "final_text_contains", text: "VERIFIED" }] },
      replaceExisting: false,
    });
    run.mockResolvedValueOnce(makeResult("Service completed."));
    const result = await supervisor.tick("acceptance-test");
    expect(result.status).toBe("blocked");
    expect(goals.get(goal.id)?.status).toBe("blocked");
    const row = db.prepare("SELECT acceptance_result FROM autonomy_goal_runs WHERE goal_id=?").get(goal.id) as { acceptance_result: string };
    expect(JSON.parse(row.acceptance_result).passed).toBe(false);
  });

  it("deduplicates queue tasks by idempotency key", () => {
    const first = supervisor.enqueueTask({ title: "Same task", idempotencyKey: "same-key" });
    const second = supervisor.enqueueTask({ title: "Same task again", idempotencyKey: "same-key" });
    expect(second?.task_id).toBe(first?.task_id);
    expect(supervisor.listScheduledTasks()).toHaveLength(1);
  });

  it("uses a database-backed goal claim across supervisor instances", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const firstRun = jest.fn().mockImplementation(async () => { await pending; return makeResult("complete"); });
    const secondRun = jest.fn().mockResolvedValue(makeResult("should not execute"));
    const first = new AutonomousSupervisor({ db, agent: { run: firstRun }, tools: makeTools(), activeRunCount: jest.fn().mockReturnValue(0), getConfig: () => config, log: () => undefined, now: () => "2026-01-01T00:00:00.000Z" });
    const second = new AutonomousSupervisor({ db, agent: { run: secondRun }, tools: makeTools(), activeRunCount: jest.fn().mockReturnValue(0), getConfig: () => config, log: () => undefined, now: () => "2026-01-01T00:00:00.000Z" });
    goals.create({ title: "Shared goal", steps: ["Inspect"], replaceExisting: false });
    const firstTick = first.tick("process-a");
    await new Promise((resolve) => setImmediate(resolve));
    const secondTick = await second.tick("process-b");
    expect(secondTick.status).toBe("busy");
    expect(secondRun).not.toHaveBeenCalled();
    release();
    await firstTick;
  });

  it("retries a failed autonomous cycle before finally blocking", async () => {
    run
      .mockResolvedValueOnce(makeResult("BLOCKED: This requires execution."))
      .mockResolvedValueOnce(makeResult("BLOCKED: Still blocked."))
      .mockResolvedValueOnce(makeResult("Inspection complete."));
    config = {
      autonomy: { enabled: true, tool_policy: { max_retries: 2, retry_backoff_seconds: 5 } },
      heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } },
    };
    const goal = goals.create({ title: "Build an app", steps: ["Build"], replaceExisting: false });

    const first = await supervisor.tick();
    expect(first.status).toBe("idle");
    expect(goals.get(goal.id)?.status).toBe("active");

    const secondRun = db.prepare("SELECT next_retry_at FROM autonomy_goal_runs WHERE goal_id=? ORDER BY started_at DESC LIMIT 1").get(goal.id) as { next_retry_at: string | null };
    db.prepare("UPDATE autonomy_goal_runs SET next_retry_at=? WHERE goal_id=?").run("2000-01-01T00:00:00.000Z", goal.id);

    const second = await supervisor.tick();
    expect(second.status).toBe("idle");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].history[0].content).toContain("REPLAN REQUIRED");
    expect(db.prepare("SELECT kind,instruction FROM autonomy_goal_replans WHERE goal_id=? ORDER BY replan_id DESC LIMIT 1").get(goal.id)).toMatchObject({
      kind: "blocked",
      instruction: expect.stringContaining("Do not repeat the blocked action"),
    });

    db.prepare("UPDATE autonomy_goal_runs SET next_retry_at=? WHERE goal_id=?").run("2000-01-01T00:00:00.000Z", goal.id);
    const third = await supervisor.tick();
    expect(third.status).toBe("completed");
    expect(goals.get(goal.id)?.status).toBe("completed");
    expect(secondRun).toBeDefined();
  });

  it("persists a scheduled task and executes it once it is due", async () => {
    const task = supervisor.enqueueTask({
      title: "Scheduled inspection",
      description: "Inspect after the schedule becomes due",
      dueAt: "2025-12-31T23:59:00.000Z",
    });
    expect(task?.status).toBe("scheduled");
    expect(supervisor.listScheduledTasks()).toHaveLength(1);

    const result = await supervisor.tick("schedule-test");
    expect(result.status).toBe("completed");
    expect(supervisor.listScheduledTasks()[0]).toMatchObject({ status: "completed", goal_id: expect.any(Number) });
    expect(goals.get(Number(supervisor.listScheduledTasks()[0].goal_id))?.status).toBe("completed");
  });

  it("migrates a Phase 3 task row without losing existing task data", () => {
    const migrationDb = new Database(":memory:");
    const migrationGoals = new GoalStore(migrationDb);
    migrationDb.exec(`CREATE TABLE autonomy_task_queue (
      task_id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      due_at TEXT NOT NULL,
      interval_seconds INTEGER,
      priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'scheduled',
      goal_id INTEGER,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    migrationDb.prepare(`INSERT INTO autonomy_task_queue(title,description,due_at,priority,status,created_at,updated_at)
      VALUES('Legacy task','keep me','2025-12-31T23:59:00.000Z',3,'scheduled','2025-12-31T23:00:00.000Z','2025-12-31T23:00:00.000Z')`).run();

    new AutonomousSupervisor({
      db: migrationDb,
      agent: { run: jest.fn().mockResolvedValue(makeResult()) }, tools: makeTools(), activeRunCount: jest.fn().mockReturnValue(0),
      getConfig: () => config,
      log: () => undefined,
      now: () => "2026-01-01T00:00:00.000Z",
    });

    expect(migrationGoals.get(999)).toBeUndefined();
    expect(migrationDb.prepare("SELECT title,description,retry_count,max_retries FROM autonomy_task_queue").get()).toMatchObject({
      title: "Legacy task", description: "keep me", retry_count: 0, max_retries: 2,
    });
    migrationDb.close();
  });

  it("marks a one-shot queued task completed after its goal finishes", async () => {
    const task = supervisor.enqueueTask({ title: "Persist result" });
    const result = await supervisor.tick("queue-test");
    expect(result.status).toBe("completed");
    expect(supervisor.listScheduledTasks()[0]).toMatchObject({ task_id: task?.task_id, status: "completed", completed_at: expect.any(String) });
  });

  it("recovers an interrupted running task after process restart", async () => {
    const task = supervisor.enqueueTask({ title: "Recover after restart" });
    await supervisor.tick("queue-test");
    const goalId = Number(supervisor.listScheduledTasks()[0].goal_id);
    db.prepare("UPDATE autonomy_task_queue SET status='running',lease_expires_at=?,updated_at=? WHERE task_id=?").run(
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", task?.task_id,
    );
    db.prepare("UPDATE pursue_goals SET status='active' WHERE id=?").run(goalId);

    const recoveredRun = jest.fn().mockResolvedValue(makeResult("Recovered successfully."));
    const restarted = new AutonomousSupervisor({
      db,
      agent: { run: recoveredRun }, tools: makeTools(), activeRunCount: jest.fn().mockReturnValue(0),
      getConfig: () => config,
      log: () => undefined,
      now: () => "2026-01-01T00:00:30.000Z",
    });

    expect(restarted.listScheduledTasks().find((row) => row.task_id === task?.task_id)).toMatchObject({ status: "queued", lease_expires_at: null });
    const result = await restarted.tick("restart-recovery");
    expect(result.status).toBe("completed");
    expect(restarted.listScheduledTasks().find((row) => row.task_id === task?.task_id)).toMatchObject({ status: "completed", completed_at: expect.any(String) });
  });

  it("keeps a recurring schedule durable while its generated goal executes", async () => {
    const task = supervisor.enqueueTask({ title: "Recurring durable check", intervalSeconds: 86400 });
    const first = await supervisor.tick("queue-test");
    expect(first.status).toBe("completed");
    const row = supervisor.listScheduledTasks().find((item) => item.task_id === task?.task_id);
    expect(row).toMatchObject({ status: "scheduled", goal_id: null, interval_seconds: 86400, retry_count: 0 });
    expect(new Date(String(row?.due_at)).getTime()).toBeGreaterThan(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("supports recurring schedules and cancellation before execution", async () => {
    const recurring = supervisor.enqueueTask({ title: "Daily check", intervalSeconds: 86400 });
    expect(recurring?.interval_seconds).toBe(86400);
    const cancelled = supervisor.enqueueTask({ title: "Do not run" });
    expect(supervisor.cancelScheduledTask(Number(cancelled?.task_id))?.status).toBe("cancelled");
    await supervisor.tick("schedule-test");
    expect(run).toHaveBeenCalledTimes(1);
    expect(supervisor.listScheduledTasks().find((task) => task.task_id === recurring?.task_id)?.status).toBe("scheduled");
  });

  it("records heartbeat checklist state and queue health", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-heartbeat-"));
    fs.mkdirSync(path.join(workspace, "identity"));
    fs.writeFileSync(path.join(workspace, "identity", "HEARTBEAT.md"), "- [notify] Check for stuck tasks in the command queue\n");
    supervisor = new AutonomousSupervisor({
      db, agent: { run }, tools: makeTools(), activeRunCount, getConfig: () => config,
      log: (message) => logs.push(message), now: () => "2026-01-01T00:00:00.000Z", workspaceRoot: workspace,
    });
    const heartbeat = await supervisor.tick("heartbeat");
    expect(heartbeat.status).toBe("idle");
    const row = db.prepare("SELECT checklist_path,checklist,queued_tasks,blocked_goals,verifier_flags,recovered_tasks,idle_minutes,probe_ok FROM autonomy_heartbeat_cycles ORDER BY cycle_id DESC LIMIT 1").get() as { checklist_path: string; checklist: string; queued_tasks: number; blocked_goals: number; verifier_flags: number; recovered_tasks: number; idle_minutes: number; probe_ok: number };
    expect(row.checklist_path).toBe("identity/HEARTBEAT.md");
    expect(row.checklist).toContain("Check for stuck tasks");
    expect(row.queued_tasks).toBe(0);
    expect(row.blocked_goals).toBe(0);
    expect(row.verifier_flags).toBe(0);
    expect(row.recovered_tasks).toBe(0);
    expect(row.idle_minutes).toBe(5);
    expect(row.probe_ok).toBe(1);
  });

  it("executes due schedules even while a foreground chat run is active", async () => {
    activeRunCount.mockReturnValue(1);
    const task = supervisor.enqueueTask({ title: "Due while chatting", dueAt: "2026-01-01T00:00:00.000Z" });
    const result = await supervisor.tick("heartbeat");
    expect(result.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(supervisor.listScheduledTasks().find((item) => item.task_id === task?.task_id)).toBeDefined();
  });

  it("recovers a stale running task lease during heartbeat maintenance", async () => {
    const task = supervisor.enqueueTask({ title: "Stale queue item", dueAt: "2030-01-01T00:00:00.000Z" });
    const goal = goals.create({ title: "Stale linked goal", steps: ["Recover"], replaceExisting: false });
    db.prepare("UPDATE autonomy_task_queue SET status='running',goal_id=?,lease_expires_at=?,updated_at=? WHERE task_id=?").run(
      goal.id, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", task?.task_id,
    );
    const result = await supervisor.tick("heartbeat");
    // After the lease is recovered the goal is picked up and executed in the same tick.
    expect(result.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(supervisor.listScheduledTasks().find((item) => item.task_id === task?.task_id)).toMatchObject({ lease_expires_at: null });
    expect(goals.get(goal.id)?.status).toBe("completed");
    const row = db.prepare("SELECT recovered_tasks FROM autonomy_heartbeat_cycles ORDER BY cycle_id DESC LIMIT 1").get() as { recovered_tasks: number };
    expect(row.recovered_tasks).toBe(1);
  });

  it("rotates to a pending goal while an active goal is in retry backoff", async () => {
    run
      .mockResolvedValueOnce(makeResult("BLOCKED: temporary"))
      .mockResolvedValueOnce(makeResult("Second goal complete."));
    config = { autonomy: { enabled: true, tool_policy: { max_retries: 2, retry_backoff_seconds: 60 } }, heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } } };
    const first = goals.create({ title: "First goal", priority: 5, steps: ["First"], replaceExisting: false });
    const second = goals.create({ title: "Second goal", priority: 1, steps: ["Second"], replaceExisting: false });
    const firstRun = await supervisor.tick("test");
    expect(firstRun.goalId).toBe(first.id);
    const secondRun = db.prepare("SELECT next_retry_at FROM autonomy_goal_runs WHERE goal_id=? ORDER BY started_at DESC LIMIT 1").get(first.id) as { next_retry_at: string | null };
    expect(secondRun.next_retry_at).toBeTruthy();
    const rotated = await supervisor.tick("test");
    expect(rotated.status).toBe("completed");
    expect(rotated.goalId).toBe(second.id);
  });

  it("recovers an expired goal lease and allows the goal to run again", async () => {
    const goal = goals.create({ title: "Expired lease", steps: ["Recover"], replaceExisting: false });
    db.prepare("INSERT INTO autonomy_goal_runs(run_id,goal_id,trigger_source,status,started_at,attempt) VALUES(?,?,?,?,?,?)").run("stale-run", goal.id, "restart", "running", "2025-01-01T00:00:00.000Z", 1);
    db.prepare("INSERT INTO autonomy_goal_claims(goal_id,run_id,lease_expires_at,updated_at) VALUES(?,?,?,?)").run(goal.id, "stale-run", "2025-01-01T00:01:00.000Z", "2025-01-01T00:00:00.000Z");
    const recovered = new AutonomousSupervisor({
      db,
      agent: { run }, tools: makeTools(), activeRunCount: jest.fn().mockReturnValue(0),
      getConfig: () => config,
      log: () => undefined,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM autonomy_goal_claims WHERE goal_id=?").get(goal.id)).toEqual({ count: 0 });
    expect(db.prepare("SELECT status FROM autonomy_goal_runs WHERE run_id='stale-run'").get()).toEqual({ status: "failed" });
    const result = await recovered.tick("restart");
    expect(result.goalId).toBe(goal.id);
  });

  it("retains recurring schedules after a terminal failure", async () => {
    run.mockResolvedValueOnce(makeResult("BLOCKED: recurring failure"));
    config = { autonomy: { enabled: true, tool_policy: { max_retries: 0, retry_backoff_seconds: 5 } }, heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } } };
    const task = supervisor.enqueueTask({ title: "Recurring failure", intervalSeconds: 3600 });
    const result = await supervisor.tick("schedule");
    expect(result.status).toBe("blocked");
    expect(supervisor.listScheduledTasks().find((item) => item.task_id === task?.task_id)).toMatchObject({ status: "scheduled", goal_id: null, interval_seconds: 3600 });
  });

  it("rate-limits event triggers and keeps event payload hashing stable", () => {
    config = { autonomy: { enabled: true, event_triggers: { max_per_minute: 1, cooldown_seconds: 0 } }, heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } } };
    supervisor.addEventTrigger({ eventName: "message:received", title: "Event task" });
    const first = supervisor.triggerEvent("message:received", { b: 2, a: 1 });
    const duplicate = supervisor.triggerEvent("message:received", { a: 1, b: 2 });
    const second = supervisor.triggerEvent("message:received", { a: 3, b: 4 });
    expect(first.triggered).toBe(1);
    expect(duplicate.triggered).toBe(0);
    expect(second.triggered).toBe(0);
    expect(supervisor.listScheduledTasks()).toHaveLength(1);
  });

  it("does not run when autonomy is disabled", async () => {
    config = { autonomy: { enabled: false }, heartbeat: { enabled: true, auto_actions: { enabled: true } } };
    goals.create({ title: "Do not run", steps: ["Inspect"], replaceExisting: false });

    const result = await supervisor.tick();

    expect(result.status).toBe("disabled");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not pause or skip an autonomous goal while a foreground run is active", async () => {
    activeRunCount.mockReturnValue(1);
    goals.create({ title: "Keep running during chat", steps: ["Inspect"], replaceExisting: false });

    const result = await supervisor.tick();

    expect(result.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  describe("adaptive ambient decisions", () => {
    let nowMs: number;
    let spy: jest.SpyInstance;

    beforeEach(() => {
      nowMs = 1_000_000;
      spy = jest.spyOn(Date, "now").mockImplementation(() => nowMs);
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_chunks (id TEXT PRIMARY KEY, region TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      `);
      config = {
        autonomy: { enabled: true },
        heartbeat: { enabled: true, auto_actions: { enabled: true }, proactive: { enabled: true, decision_interval_seconds: 100, max_decision_interval_seconds: 400, decision_backoff_multiplier: 2 } },
      };
      run.mockResolvedValue(makeResult("NO_ACTION"));
    });

    afterEach(() => spy.mockRestore());

    const decide = (trigger: "startup" | "idle") => (supervisor as any).runAmbientDecision(trigger) as Promise<boolean>;

    it("skips the LLM while nothing changed and stretches the interval after NO_ACTION", async () => {
      await decide("startup");
      expect(run).toHaveBeenCalledTimes(1);

      nowMs += 100_000; // base interval elapsed, but state unchanged -> streak=1 -> needs 200s
      await decide("idle");
      expect(run).toHaveBeenCalledTimes(1);

      nowMs += 100_000; // 200s total
      await decide("idle");
      expect(run).toHaveBeenCalledTimes(2);

      nowMs += 399_000; // streak=2 -> 400s cap, not yet due
      await decide("idle");
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("returns to the base interval as soon as the world state changes", async () => {
      await decide("startup");
      nowMs += 100_000;
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES('m1','miki-main-chat','user','hello','2026-01-01T00:00:00Z')").run();
      await decide("idle");
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("never calls the LLM again inside the base interval, even when state changed", async () => {
      await decide("startup");
      nowMs += 10_000;
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES('m1','miki-main-chat','user','hello','2026-01-01T00:00:00Z')").run();
      await decide("idle");
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("resets the streak after an actionable decision", async () => {
      await decide("startup");
      run.mockResolvedValueOnce(makeResult("Found a blocker worth reporting."));
      nowMs += 200_000;
      expect(await decide("idle")).toBe(true);
      expect(supervisor.status().proactive_loop.no_action_streak).toBe(0);
    });
  });
});
