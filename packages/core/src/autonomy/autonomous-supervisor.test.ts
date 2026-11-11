import Database from "better-sqlite3";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoalStore } from "../api/goals-router.js";
import { AutonomousSupervisor, classifyFailure, similarFailure } from "./autonomous-supervisor.js";
import { ToolRegistry } from "../engine/tool-registry.js";


/** The second-check / next-step / request-audit features add model calls; these legacy-mechanics tests count calls, so they run with the features off (autonomous-supervisor-verification.test.ts covers them on). */
const LEGACY_PROACTIVE = { double_check: false, next_step_goals: false, user_request_audit: false };

function withLegacyProactive(cfg: Record<string, unknown>): Record<string, unknown> {
  const heartbeat = (cfg.heartbeat ?? {}) as Record<string, unknown>;
  return { ...cfg, heartbeat: { ...heartbeat, proactive: { ...LEGACY_PROACTIVE, ...((heartbeat.proactive ?? {}) as Record<string, unknown>) } } };
}

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
    config = { autonomy: { enabled: true, tool_policy: { require_acceptance_contract: false } }, heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } } };
    supervisor = new AutonomousSupervisor({
      db,
      agent: { run },
      tools: makeTools(),
      activeRunCount,
      getConfig: () => withLegacyProactive(config),
      log: (message) => logs.push(message),
      now: () => "2026-01-01T00:00:00.000Z",
    });
  });

  afterEach(() => db.close());

  it("reports the live supervisor, durable schedule and retry state for the conversational agent", () => {
    supervisor.enqueueTask({ title: "Future scheduled check", dueAt: "2030-01-01T00:00:00.000Z" });

    const stopped = supervisor.runtimeAwarenessContext();
    expect(stopped).toContain("Supervisor loop: STOPPED");
    expect(stopped).toContain("Effective autonomy activation enabled: yes");
    expect(supervisor.runtimeAwarenessContext(false)).toContain("Effective autonomy activation enabled: no");
    expect(supervisor.runtimeAwarenessContext(false)).toContain("DISABLED_BY_CONFIGURATION");
    expect(stopped).toContain("1 future scheduled tasks");
    expect(stopped).toContain("transient model/provider failures are retried");
    expect(supervisor.status().proactive_loop.llm_call_lifecycle).toMatchObject({
      model_call_self_schedules: false,
      autonomous_follow_up_enabled: false,
      supervisor_running: false,
    });

    (supervisor as any).running = true;
    expect(supervisor.runtimeAwarenessContext()).toContain("Supervisor loop: RUNNING");
    expect(supervisor.runtimeAwarenessContext()).toContain("the model does not call itself again");
    expect(supervisor.runtimeAwarenessContext()).toContain("host-side AutonomousSupervisor owns subsequent LLM requests");
    expect(supervisor.status().proactive_loop.llm_call_lifecycle).toEqual({
      model_call_self_schedules: false,
      subsequent_call_owner: "gateway_autonomous_supervisor",
      autonomous_follow_up_enabled: true,
      provider_backoff_active: false,
      supervisor_running: true,
      paused: false,
    });
    (supervisor as any).circuitOpen = true;
    expect(supervisor.runtimeAwarenessContext()).toContain("temporarily waiting for provider recovery/backoff");
    expect(supervisor.status().proactive_loop.llm_call_lifecycle.provider_backoff_active).toBe(true);
    (supervisor as any).circuitOpen = false;
    supervisor.pause();
    expect(supervisor.runtimeAwarenessContext()).toContain("Supervisor loop: PAUSED");
    expect(supervisor.status().proactive_loop.llm_call_lifecycle.autonomous_follow_up_enabled).toBe(false);
    supervisor.resume();
    (supervisor as any).running = false;
  });

  it("restarts its supervisor loop after an unexpected exit and cancels recovery on stop", async () => {
    jest.useFakeTimers();
    try {
      const loop = jest.spyOn(supervisor as any, "runLoop")
        .mockRejectedValueOnce(new Error("injected supervisor loop failure"))
        .mockResolvedValue(undefined);
      supervisor.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(supervisor.status()).toMatchObject({ running: true, loop_restart_pending: true, loop_restart_count: 1 });
      expect(logs.some((line) => line.includes("restarting in 1s"))).toBe(true);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(loop).toHaveBeenCalledTimes(2);
      await supervisor.stop();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(loop).toHaveBeenCalledTimes(2);
      expect(supervisor.status().running).toBe(false);
    } finally {
      await supervisor.stop();
      jest.useRealTimers();
    }
  });

  it("pauses and resumes autonomous work without losing persistent goals", async () => {
    const goal = goals.create({ title: "Paused goal", steps: ["Inspect"], replaceExisting: false });
    supervisor.pause();
    expect(supervisor.status().paused).toBe(true);
    expect((await supervisor.tick("paused-test")).reason).toMatch(/paused/i);
    expect(run).not.toHaveBeenCalled();
    expect(goals.get(goal.id)?.status).toBe("active");
    supervisor.resume();
    expect(supervisor.status().paused).toBe(false);
    expect((await supervisor.tick("resumed-test")).status).toBe("completed");
  });

  it("plans autonomous goals with the exact execution tool allowlist before running them", async () => {
    const plan = {
      id: "autonomous-plan",
      goal: "Inspect workspace",
      source: "llm" as const,
      complexity: "multi_step" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      steps: [{ id: "s1", title: "Inspect workspace", tool: "workspace_list", status: "pending" as const }],
    };
    const planAgent = jest.fn().mockResolvedValue(plan);
    supervisor = new AutonomousSupervisor({
      db,
      agent: { run, plan: planAgent },
      tools: makeTools(),
      activeRunCount,
      getConfig: () => withLegacyProactive(config),
      log: (message) => logs.push(message),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    goals.create({ title: "Inspect workspace", steps: ["Inspect"], replaceExisting: false });
    await supervisor.tick("planned-goal");
    expect(planAgent).toHaveBeenCalledTimes(1);
    expect(planAgent.mock.calls[0][1]).toEqual(expect.objectContaining({ toolNames: expect.arrayContaining(["workspace_list", "memory_search"]) }));
    expect(planAgent.mock.calls[0][1].toolNames).not.toContain("terminal_run");
    expect(run.mock.calls[0][0].plan).toEqual(plan);
  });

  it("exposes every registered tool to autonomous goals in sandbox owner mode", async () => {
    const tools = makeTools();
    tools.register({
      name: "owner_custom_action",
      description: "A custom high-impact tool available only in this test registry.",
      risk: "destructive",
      approval: "required",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    });
    config = {
      agent: { security: { sandbox_mode: true } },
      autonomy: { enabled: true, tool_policy: { auto_approve_all: true, allowed_tools: ["web_search"], require_acceptance_contract: false } },
      heartbeat: { enabled: true },
    };
    supervisor = new AutonomousSupervisor({
      db,
      agent: { run },
      tools,
      activeRunCount,
      getConfig: () => withLegacyProactive(config),
      log: (message) => logs.push(message),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    goals.create({ title: "Use a registered tool", steps: ["Inspect"], replaceExisting: false });

    const result = await supervisor.tick("owner-mode-test");

    expect(result.status).toBe("completed");
    const exposedTools = run.mock.calls[0][0].tools.names();
    expect(exposedTools).toEqual(expect.arrayContaining(tools.names()));
    expect(exposedTools).toContain("owner_custom_action");
  });

  it("runs an active goal with only the safe tool allowlist and persists completion", async () => {
    const goal = goals.create({ title: "Inspect workspace", steps: ["Inspect"], replaceExisting: false });
    const result = await supervisor.tick("test");

    expect(result.status).toBe("completed");
    expect(result.goalId).toBe(goal.id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].tools.names()).toEqual([
      "workspace_list", "file_info", "file_read", "workspace_search", "memory_search", "memory_add", "goal_status", "file_mkdir", "file_write", "autonomy_share_discovery", "autonomy_drive_done",
    ]);
    expect(run.mock.calls[0][0].approvalPolicy).toBeDefined();
    // Goal runs permit configured fallback routes during provider outages. `undefined`
    // is intentional: only `true` disables the engine's configured fallback chain.
    expect(run.mock.calls[0][0].disableModelFallback).toBeUndefined();
    // Autonomous goal cycles do not impose per-cycle tool-call or completion-token budgets.
    expect(run.mock.calls[0][0].maxToolCalls).toBeUndefined();
    expect(run.mock.calls[0][0].maxCompletionTokens).toBeUndefined();
    expect(run.mock.calls[0][0].maxTotalTokens).toBeUndefined();
    expect(goals.get(goal.id)?.status).toBe("completed");
    expect(db.prepare("SELECT status FROM autonomy_goal_runs WHERE run_id=?").get(result.runId)).toEqual({ status: "completed" });
  });

  it("fails closed on completed model output when deterministic acceptance is required", async () => {
    config = {
      // Omitting require_acceptance_contract must stay fail-closed by default.
      autonomy: { enabled: true, tool_policy: { max_retries: 0 } },
      heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } },
    };
    const goal = goals.create({
      title: "Verify service",
      steps: ["Verify"],
      acceptance: { mode: "all", checks: [{ type: "final_text_contains", text: "VERIFIED" }, { type: "file_exists", path: "autonomy/report.txt" }] },
      replaceExisting: false,
    });
    run.mockResolvedValueOnce(makeResult("Service completed."));
    const result = await supervisor.tick("acceptance-test");
    // Missing evidence never completes. The goal goes back to pending (re-planning) with a retry scheduled.
    expect(result.status).toBe("idle");
    expect(goals.get(goal.id)?.status).toBe("pending");
    const row = db.prepare("SELECT status,next_retry_at,acceptance_result FROM autonomy_goal_runs WHERE goal_id=?").get(goal.id) as { status: string; next_retry_at: string | null; acceptance_result: string };
    expect(row.status).toBe("retry_wait");
    expect(row.next_retry_at).toBeTruthy();
    expect(JSON.parse(row.acceptance_result).passed).toBe(false);
  });

  it("blocks a goal missing a valid acceptance contract before running any tools", async () => {
    config = { autonomy: { enabled: true, tool_policy: { max_retries: 0 } }, heartbeat: { enabled: true } };
    const goal = goals.create({ title: "Unverifiable work", steps: ["Do the work"], replaceExisting: false });
    const result = await supervisor.tick("missing-contract-test");
    expect(result.status).toBe("blocked");
    expect(run).not.toHaveBeenCalled();
    expect(goals.get(goal.id)?.status).toBe("blocked");
    const row = db.prepare("SELECT status,attempt,acceptance_result FROM autonomy_goal_runs WHERE goal_id=?").get(goal.id) as { status: string; attempt: number; acceptance_result: string };
    expect(row.status).toBe("blocked");
    expect(row.attempt).toBe(0);
    expect(JSON.parse(row.acceptance_result).passed).toBe(false);
  });

  it("rejects scheduled goals without acceptance evidence when the default policy requires it", () => {
    config = { autonomy: { enabled: true, tool_policy: { require_acceptance_contract: true, safe_write_roots: ["autonomy"] } }, heartbeat: { enabled: true } };
    expect(() => supervisor.enqueueTask({ title: "Unverifiable schedule" })).toThrow(/acceptance contract is required/i);
    const task = supervisor.enqueueTask({
      title: "Verified schedule",
      acceptance: { mode: "all", checks: [{ type: "file_exists", path: "autonomy/scheduled-result.md" }] },
    });
    expect(task).toMatchObject({ title: "Verified schedule", status: "scheduled" });
  });

  it("pauses legacy due schedules until an owner adds a valid acceptance contract", async () => {
    config = { autonomy: { enabled: true, tool_policy: { require_acceptance_contract: false } }, heartbeat: { enabled: true } };
    const legacy = supervisor.enqueueTask({ title: "Legacy scheduled goal" });
    const id = Number(legacy?.task_id);

    config = {
      autonomy: { enabled: true, tool_policy: { require_acceptance_contract: true, safe_write_roots: ["autonomy"] } },
      heartbeat: { enabled: true, proactive: { enabled: false, startup_decision: false, llm_when_idle: false } },
    };
    await supervisor.tick("legacy-schedule-migration");
    expect(supervisor.listScheduledTasks().find((task) => task.task_id === id)).toMatchObject({ status: "paused", last_outcome: "acceptance_required" });
    expect(run).not.toHaveBeenCalled();
    expect(() => supervisor.resumeScheduledTask(id)).toThrow(/valid acceptance contract/i);

    const repaired = supervisor.updateScheduledTask(id, {
      acceptance: { mode: "all", checks: [{ type: "file_exists", path: "autonomy/legacy-result.md" }] },
    });
    expect(repaired?.acceptance_contract).toContain("legacy-result.md");
    expect(supervisor.resumeScheduledTask(id)?.status).toBe("scheduled");
  });

  it("requires verifiable acceptance before registering an event trigger", () => {
    config = { autonomy: { enabled: true, tool_policy: { require_acceptance_contract: true, safe_write_roots: ["autonomy"] } }, heartbeat: { enabled: true } };
    expect(() => supervisor.addEventTrigger({ eventName: "document.created", title: "Review document" }))
      .toThrow(/acceptance contract is required/i);
    const trigger = supervisor.addEventTrigger({
      eventName: "document.created",
      title: "Review document",
      acceptance: { mode: "all", checks: [{ type: "file_exists", path: "autonomy/review.md" }] },
    });
    expect(trigger).toMatchObject({ event_name: "document.created", enabled: 1 });
  });

  it("allows an owner to repair a legacy event trigger with an acceptance contract before enabling it", () => {
    config = { autonomy: { enabled: true, tool_policy: { require_acceptance_contract: false } }, heartbeat: { enabled: true } };
    const legacy = supervisor.addEventTrigger({ eventName: "document.created", title: "Review legacy document" });
    const triggerId = Number((legacy as Record<string, unknown>).trigger_id);

    config = { autonomy: { enabled: true, tool_policy: { require_acceptance_contract: true, safe_write_roots: ["autonomy"] } }, heartbeat: { enabled: true } };
    expect(() => supervisor.updateEventTrigger(triggerId, { enabled: true })).toThrow(/acceptance contract/i);

    const repaired = supervisor.updateEventTrigger(triggerId, {
      acceptance: { mode: "all", checks: [{ type: "file_exists", path: "autonomy/reviewed-document.md" }] },
      enabled: true,
    });
    expect(repaired).toMatchObject({ trigger_id: triggerId, enabled: 1 });
    expect(supervisor.triggerEvent("document.created", { eventId: "legacy-repaired" }).triggered).toBe(1);
    expect(supervisor.listScheduledTasks()).toHaveLength(1);
  });

  it("ignores legacy queue-depth caps even when the old unlimited flag is absent", () => {
    config = { autonomy: { enabled: true, max_queue_depth: 1, tool_policy: { require_acceptance_contract: false } }, heartbeat: { enabled: true } };
    supervisor.enqueueTask({ title: "First task", dueAt: "2030-01-01T00:00:00.000Z" });
    expect(() => supervisor.enqueueTask({ title: "Second task", dueAt: "2030-01-02T00:00:00.000Z" })).not.toThrow();
    expect(supervisor.listScheduledTasks()).toHaveLength(2);
  });

  it("does not let a legacy configuration flag reactivate queue-depth caps", () => {
    config = { autonomy: { enabled: true, unlimited_budgets: true, max_queue_depth: 1, tool_policy: { require_acceptance_contract: false } }, heartbeat: { enabled: true } };
    supervisor.enqueueTask({ title: "First task", dueAt: "2030-01-01T00:00:00.000Z" });
    expect(() => supervisor.enqueueTask({ title: "Second task", dueAt: "2030-01-02T00:00:00.000Z" })).not.toThrow();
    expect(supervisor.listScheduledTasks()).toHaveLength(2);
  });

  it("does not expose every registered tool to autonomous goals", async () => {
    const tools = makeTools();
    tools.register({ name: "terminal_run", description: "execute a shell command", risk: "execute", parameters: { type: "object", properties: {} }, approval: "auto", execute: async () => ({ ok: true }) });
    const isolated = new AutonomousSupervisor({
      db,
      agent: { run },
      tools,
      activeRunCount,
      getConfig: () => withLegacyProactive(config),
      log: (message) => logs.push(message),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    goals.create({ title: "Read safe files", steps: ["Inspect"], replaceExisting: false });
    await isolated.tick("allowlist-test");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].tools.names()).not.toContain("terminal_run");
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
    const first = new AutonomousSupervisor({ db, agent: { run: firstRun }, tools: makeTools(), activeRunCount: jest.fn().mockReturnValue(0), getConfig: () => withLegacyProactive(config), log: () => undefined, now: () => "2026-01-01T00:00:00.000Z" });
    const second = new AutonomousSupervisor({ db, agent: { run: secondRun }, tools: makeTools(), activeRunCount: jest.fn().mockReturnValue(0), getConfig: () => withLegacyProactive(config), log: () => undefined, now: () => "2026-01-01T00:00:00.000Z" });
    goals.create({ title: "Shared goal", steps: ["Inspect"], replaceExisting: false });
    const firstTick = first.tick("process-a");
    await new Promise((resolve) => setImmediate(resolve));
    const secondTick = await second.tick("process-b");
    expect(secondTick.status).toBe("busy");
    expect(secondRun).not.toHaveBeenCalled();
    release();
    await firstTick;
  });

  it("retries failed autonomous cycles with backoff until a later attempt succeeds", async () => {
    run
      .mockResolvedValueOnce({ ...makeResult("", "failed"), error: "Tool execution failed; re-plan required." })
      .mockResolvedValueOnce({ ...makeResult("", "failed"), error: "The alternative approach failed; re-plan required." })
      .mockResolvedValueOnce(makeResult("Inspection complete."));
    config = {
      autonomy: { enabled: true, tool_policy: { max_retries: 2, retry_backoff_seconds: 5, require_acceptance_contract: false } },
      heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } },
    };
    const goal = goals.create({ title: "Build an app", steps: ["Build"], replaceExisting: false });

    const first = await supervisor.tick();
    expect(first.status).toBe("idle");
    expect(goals.get(goal.id)?.status).toBe("pending");

    const secondRun = db.prepare("SELECT next_retry_at FROM autonomy_goal_runs WHERE goal_id=? ORDER BY started_at DESC LIMIT 1").get(goal.id) as { next_retry_at: string | null };
    db.prepare("UPDATE autonomy_goal_runs SET next_retry_at=? WHERE goal_id=?").run("2000-01-01T00:00:00.000Z", goal.id);

    const second = await supervisor.tick();
    expect(second.status).toBe("idle");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].history[0].content).toContain("REPLAN REQUIRED");
    expect(db.prepare("SELECT kind,instruction FROM autonomy_goal_replans WHERE goal_id=? ORDER BY replan_id DESC LIMIT 1").get(goal.id)).toMatchObject({
      kind: "failed",
      instruction: expect.stringContaining("Diagnose the likely cause"),
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
    const durable = db.prepare("SELECT task_id,status,version,goal FROM miki_tasks ORDER BY created_at DESC LIMIT 1").get() as { task_id: string; status: string; version: number; goal: string };
    expect(durable).toMatchObject({ status: "completed", version: 3, goal: "Scheduled inspection" });
    expect(db.prepare("SELECT durable_task_id FROM autonomy_task_queue WHERE task_id=?").get(task?.task_id)).toEqual({ durable_task_id: durable.task_id });
    expect(db.prepare("SELECT to_status FROM miki_task_events WHERE task_id=? ORDER BY id").all(durable.task_id)).toEqual([
      { to_status: "queued" },
      { to_status: "running" },
      { to_status: "verifying" },
      { to_status: "completed" },
    ]);
  });

  it("reconciles a failed durable task mirror from the persistent outbox on heartbeat", async () => {
    const task = supervisor.enqueueTask({ title: "Mirror recovery task" });
    db.exec(`CREATE TRIGGER block_durable_task_mirror BEFORE INSERT ON miki_tasks
      BEGIN SELECT RAISE(ABORT, 'temporary durable mirror outage'); END;`);

    const result = await supervisor.tick("queue-test");
    expect(result.status).toBe("completed");
    expect(db.prepare("SELECT status FROM autonomy_task_queue WHERE task_id=?").get(task?.task_id)).toEqual({ status: "completed" });
    expect(db.prepare("SELECT status FROM autonomy_task_mirror_outbox WHERE task_id=?").get(task?.task_id)).toMatchObject({ status: "completed" });

    db.exec("DROP TRIGGER block_durable_task_mirror");
    await supervisor.tick("heartbeat");

    const queueRow = db.prepare("SELECT durable_task_id FROM autonomy_task_queue WHERE task_id=?").get(task?.task_id) as { durable_task_id: string };
    expect(db.prepare("SELECT status FROM miki_tasks WHERE task_id=?").get(queueRow.durable_task_id)).toEqual({ status: "completed" });
    expect(db.prepare("SELECT task_id FROM autonomy_task_mirror_outbox WHERE task_id=?").get(task?.task_id)).toBeUndefined();
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
      getConfig: () => withLegacyProactive(config),
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
      getConfig: () => withLegacyProactive(config),
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

  it("persists a timezone-aware Cron schedule and exposes next-run metadata", () => {
    const task = supervisor.enqueueTask({
      title: "Weekday review",
      cronExpression: "0 9 * * 1-5",
      timezone: "Asia/Dhaka",
      misfirePolicy: "skip",
    });
    expect(task).toMatchObject({
      schedule_type: "cron",
      cron_expression: "0 9 * * 1-5",
      timezone: "Asia/Dhaka",
      misfire_policy: "skip",
      status: "scheduled",
      next_run_at: "2026-01-01T03:00:00.000Z",
      missed_runs: 0,
    });
  });

  it("rejects Cron schedules without a valid timezone or with conflicting intervals", () => {
    expect(() => supervisor.enqueueTask({ title: "Bad timezone", cronExpression: "0 9 * * *", timezone: "Mars/Olympus" })).toThrow(/Invalid IANA timezone/);
    expect(() => supervisor.enqueueTask({ title: "Conflicting modes", cronExpression: "0 9 * * *", timezone: "UTC", intervalSeconds: 3600 })).toThrow(/both interval_seconds and cron_expression/);
    expect(() => supervisor.enqueueTask({ title: "Missing timezone", cronExpression: "0 9 * * *" })).toThrow(/IANA timezone is required/);
  });

  it("restores persisted Cron metadata when the supervisor is reconstructed", () => {
    const task = supervisor.enqueueTask({ title: "Restart persistence", cronExpression: "15 8 * * *", timezone: "Asia/Dhaka", misfirePolicy: "run_once" });
    const restarted = new AutonomousSupervisor({
      db,
      agent: { run },
      tools: makeTools(),
      activeRunCount,
      getConfig: () => withLegacyProactive(config),
      log: (message) => logs.push(message),
      now: () => "2026-01-01T00:00:30.000Z",
    });
    expect(restarted.listScheduledTasks().find((row) => row.task_id === task?.task_id)).toMatchObject({
      schedule_type: "cron",
      cron_expression: "15 8 * * *",
      timezone: "Asia/Dhaka",
      misfire_policy: "run_once",
      next_run_at: "2026-01-01T02:15:00.000Z",
    });
  });

  it("paginates scheduled tasks without repeating rows between pages", () => {
    supervisor.enqueueTask({ title: "Page one", dueAt: "2030-01-01T00:00:00.000Z" });
    supervisor.enqueueTask({ title: "Page two", dueAt: "2030-01-02T00:00:00.000Z" });
    supervisor.enqueueTask({ title: "Page three", dueAt: "2030-01-03T00:00:00.000Z" });
    const first = supervisor.listScheduledTasks(2, 0);
    const second = supervisor.listScheduledTasks(2, 2);
    expect(first.map((row) => row.title)).toEqual(["Page one", "Page two"]);
    expect(second.map((row) => row.title)).toEqual(["Page three"]);
  });

  it("allows safe rescheduling of one-time and interval tasks while they are scheduled or paused", () => {
    const once = supervisor.enqueueTask({ title: "One-time", dueAt: "2030-01-01T00:00:00.000Z" });
    const interval = supervisor.enqueueTask({ title: "Interval", dueAt: "2030-01-02T00:00:00.000Z", intervalSeconds: 3600 });
    const onceUpdated = supervisor.updateScheduledTask(Number(once?.task_id), { dueAt: "2030-02-01T00:00:00.000Z", title: "One-time updated" });
    const intervalUpdated = supervisor.updateScheduledTask(Number(interval?.task_id), { dueAt: "2030-02-02T00:00:00.000Z", intervalSeconds: 7200 });
    expect(onceUpdated).toMatchObject({ title: "One-time updated", schedule_type: "once", due_at: "2030-02-01T00:00:00.000Z" });
    expect(intervalUpdated).toMatchObject({ schedule_type: "interval", interval_seconds: 7200, due_at: "2030-02-02T00:00:00.000Z" });
    expect(() => supervisor.updateScheduledTask(Number(interval?.task_id), { intervalSeconds: 30 })).toThrow(/between 60 and 31536000/);
  });

  it("supports editing, pausing, resuming, and cancelling Cron schedules", () => {
    const task = supervisor.enqueueTask({ title: "Maintenance", cronExpression: "0 9 * * *", timezone: "Asia/Dhaka" });
    const id = Number(task?.task_id);
    expect(supervisor.pauseScheduledTask(id)?.status).toBe("paused");
    const updated = supervisor.updateScheduledTask(id, { cronExpression: "30 10 * * *", timezone: "Asia/Dhaka", misfirePolicy: "run_once" });
    expect(updated).toMatchObject({ status: "paused", cron_expression: "30 10 * * *", timezone: "Asia/Dhaka", misfire_policy: "run_once", next_run_at: "2026-01-01T04:30:00.000Z" });
    expect(supervisor.resumeScheduledTask(id)?.status).toBe("scheduled");
    expect(supervisor.pauseScheduledTask(id)?.status).toBe("paused");
    expect(supervisor.cancelScheduledTask(id)?.status).toBe("cancelled");
  });

  it("executes a due Cron schedule once and advances to the next occurrence", async () => {
    const task = supervisor.enqueueTask({ title: "Every minute Cron", cronExpression: "* * * * *", timezone: "UTC", misfirePolicy: "skip" });
    db.prepare("UPDATE autonomy_task_queue SET due_at=? WHERE task_id=?").run("2025-12-31T23:59:00.000Z", task?.task_id);
    const result = await supervisor.tick("cron-schedule-test");
    expect(result.status).toBe("completed");
    const row = supervisor.listScheduledTasks().find((item) => item.task_id === task?.task_id);
    expect(row).toMatchObject({ status: "scheduled", schedule_type: "cron", last_outcome: "completed", missed_runs: 0 });
    expect(row?.due_at).toBe("2026-01-01T00:01:00.000Z");
  });

  it("skips stale Cron occurrences by default instead of replaying downtime", async () => {
    const task = supervisor.enqueueTask({ title: "Stale Cron", cronExpression: "* * * * *", timezone: "UTC", misfirePolicy: "skip" });
    db.prepare("UPDATE autonomy_task_queue SET due_at=? WHERE task_id=?").run("2025-12-31T23:45:00.000Z", task?.task_id);
    await supervisor.tick("cron-misfire-test");
    const row = supervisor.listScheduledTasks().find((item) => item.task_id === task?.task_id);
    expect(row).toMatchObject({ status: "scheduled", last_outcome: "misfire_skipped", missed_runs: 1, next_run_at: "2026-01-01T00:01:00.000Z" });
  });

  it("coalesces stale Cron occurrences into one recovery goal for run_once", async () => {
    const task = supervisor.enqueueTask({ title: "Recover Cron", cronExpression: "* * * * *", timezone: "UTC", misfirePolicy: "run_once" });
    db.prepare("UPDATE autonomy_task_queue SET due_at=? WHERE task_id=?").run("2025-12-31T23:45:00.000Z", task?.task_id);
    const result = await supervisor.tick("cron-run-once-misfire-test");
    const row = supervisor.listScheduledTasks().find((item) => item.task_id === task?.task_id);
    expect(result.status).toBe("completed");
    expect(row).toMatchObject({ status: "scheduled", last_outcome: "completed", missed_runs: 1, next_run_at: "2026-01-01T00:01:00.000Z", last_run_at: expect.any(String) });
    expect(run).toHaveBeenCalledTimes(1);
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
      db, agent: { run }, tools: makeTools(), activeRunCount, getConfig: () => withLegacyProactive(config),
      log: (message) => logs.push(message), now: () => "2026-01-01T00:00:00.000Z", workspaceRoot: workspace,
    });
    const heartbeat = await supervisor.tick("heartbeat");
    // The checklist line is now materialized as a recurring task and executed on schedule.
    expect(heartbeat.status).toBe("completed");
    expect(supervisor.listScheduledTasks(10).map((t: any) => t.title)).toContain("Heartbeat: Check for stuck tasks in the command queue");
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
      .mockResolvedValueOnce({ ...makeResult("", "failed"), error: "Temporary execution failure." })
      .mockResolvedValueOnce(makeResult("Second goal complete."));
    config = { autonomy: { enabled: true, tool_policy: { max_retries: 2, retry_backoff_seconds: 60, require_acceptance_contract: false } }, heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } } };
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
      getConfig: () => withLegacyProactive(config),
      log: () => undefined,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM autonomy_goal_claims WHERE goal_id=?").get(goal.id)).toEqual({ count: 0 });
    expect(db.prepare("SELECT status FROM autonomy_goal_runs WHERE run_id='stale-run'").get()).toEqual({ status: "failed" });
    const result = await recovered.tick("restart");
    expect(result.goalId).toBe(goal.id);
  });

  describe("crash recovery", () => {
    const NOW = "2026-01-01T00:00:00.000Z";
    const FUTURE_LEASE = "2026-01-01T00:05:00.000Z";

    /** A pid that belonged to a process which has already exited. */
    function deadPid(): number {
      const child = spawnSync(process.execPath, ["-e", "0"]);
      return child.pid as number;
    }

    function plantClaim(goalId: number, owner: { pid: number | null; instance: string | null; host?: string | null }) {
      db.prepare("INSERT INTO autonomy_goal_runs(run_id,goal_id,trigger_source,status,started_at,attempt) VALUES(?,?,?,?,?,?)")
        .run("crashed-run", goalId, "restart", "running", "2025-12-31T23:59:00.000Z", 1);
      db.prepare("INSERT INTO autonomy_goal_claims(goal_id,run_id,lease_expires_at,updated_at,owner_pid,owner_host,owner_instance) VALUES(?,?,?,?,?,?,?)")
        .run(goalId, "crashed-run", FUTURE_LEASE, "2025-12-31T23:59:00.000Z", owner.pid, owner.host === undefined ? os.hostname() : owner.host, owner.instance);
    }

    function restart() {
      return new AutonomousSupervisor({
        db, agent: { run }, tools: makeTools(), activeRunCount: jest.fn().mockReturnValue(0),
        getConfig: () => withLegacyProactive(config), log: (message) => logs.push(message), now: () => NOW,
      });
    }

    it("recovers the claim of a dead process at startup without waiting for the 300s lease", async () => {
      const goal = goals.create({ title: "Crashed goal", steps: ["Resume"], replaceExisting: false });
      plantClaim(goal.id, { pid: deadPid(), instance: "dead-instance" });
      const restarted = restart();
      expect(db.prepare("SELECT COUNT(*) AS count FROM autonomy_goal_claims WHERE goal_id=?").get(goal.id)).toEqual({ count: 0 });
      expect(db.prepare("SELECT status,error FROM autonomy_goal_runs WHERE run_id='crashed-run'").get())
        .toMatchObject({ status: "failed", error: expect.stringMatching(/owner process died/) });
      const result = await restarted.tick("restart");
      expect(result.status).toBe("completed");
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("recovers a claim written by an earlier incarnation of the same pid (container restart)", () => {
      const goal = goals.create({ title: "Same pid goal", steps: ["Resume"], replaceExisting: false });
      plantClaim(goal.id, { pid: process.pid, instance: "previous-incarnation" });
      restart();
      expect(db.prepare("SELECT COUNT(*) AS count FROM autonomy_goal_claims WHERE goal_id=?").get(goal.id)).toEqual({ count: 0 });
    });

    it("keeps the claim of a live process until its lease expires", async () => {
      const goal = goals.create({ title: "Live owner goal", steps: ["Wait"], replaceExisting: false });
      const child: ChildProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
      try {
        plantClaim(goal.id, { pid: child.pid as number, instance: "live-instance" });
        const restarted = restart();
        expect(db.prepare("SELECT COUNT(*) AS count FROM autonomy_goal_claims WHERE goal_id=?").get(goal.id)).toEqual({ count: 1 });
        expect((await restarted.tick("restart")).status).toBe("busy");
        expect(run).not.toHaveBeenCalled();
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("keeps legacy claims without an owner and claims from another host until the lease expires", () => {
      const legacy = goals.create({ title: "Legacy claim goal", steps: ["Wait"], replaceExisting: false });
      db.prepare("INSERT INTO autonomy_goal_claims(goal_id,run_id,lease_expires_at,updated_at) VALUES(?,?,?,?)").run(legacy.id, "legacy-run", FUTURE_LEASE, NOW);
      const foreign = goals.create({ title: "Foreign host goal", steps: ["Wait"], replaceExisting: false });
      db.prepare("INSERT INTO autonomy_goal_claims(goal_id,run_id,lease_expires_at,updated_at,owner_pid,owner_host,owner_instance) VALUES(?,?,?,?,?,?,?)")
        .run(foreign.id, "foreign-run", FUTURE_LEASE, NOW, deadPid(), "some-other-host", "foreign-instance");
      restart();
      expect(db.prepare("SELECT COUNT(*) AS count FROM autonomy_goal_claims").get()).toEqual({ count: 2 });
    });

    it("tells the resumed attempt which tool calls already happened so they are not repeated", async () => {
      const goal = goals.create({ title: "Side effects goal", steps: ["Write", "Send"], replaceExisting: false });
      const call = (id: string, name: string, risk: string, status: string, args: string, resultPreview?: string) => ({
        type: "tool.call", runId: "ignored", turn: 1, call: { id, name, risk, status, arguments: args, turn: 1, startedAt: NOW, resultPreview },
      });
      // The first process runs two calls to completion, starts a third and then dies mid-call.
      const hanging = jest.fn().mockImplementation((request: { onEvent: (event: unknown) => void }) => {
        request.onEvent(call("c1", "file_write", "write", "running", '{"path":"report.txt"}'));
        request.onEvent(call("c1", "file_write", "write", "succeeded", '{"path":"report.txt"}', "wrote 120 bytes"));
        request.onEvent(call("c2", "file_read", "read", "succeeded", '{"path":"input.txt"}', "input"));
        request.onEvent(call("c3", "terminal_run", "execute", "running", '{"command":"deploy.sh"}'));
        return new Promise(() => undefined);
      });
      const first = new AutonomousSupervisor({ db, agent: { run: hanging }, tools: makeTools(), activeRunCount: jest.fn().mockReturnValue(0), getConfig: () => withLegacyProactive(config), log: () => undefined, now: () => NOW });
      void first.tick("process-a");
      await new Promise((resolve) => setImmediate(resolve));
      expect(db.prepare("SELECT COUNT(*) AS count FROM autonomy_goal_tool_calls WHERE goal_id=?").get(goal.id)).toEqual({ count: 3 });

      // The process dies: its claim now belongs to a pid that no longer exists.
      db.prepare("UPDATE autonomy_goal_claims SET owner_pid=?,owner_instance='dead-instance' WHERE goal_id=?").run(deadPid(), goal.id);
      const restarted = restart();
      expect((await restarted.tick("restart")).status).toBe("completed");

      const prompt = String(run.mock.calls[0][0].goal);
      expect(prompt).toContain("TOOL CALLS ALREADY COMPLETED IN EARLIER ATTEMPTS");
      expect(prompt).toContain('file_write {"path":"report.txt"} => wrote 120 bytes');
      expect(prompt).toContain("1 read-only calls not listed");
      expect(prompt).not.toContain("input.txt");
      expect(prompt).toContain("STARTED BUT NOT CONFIRMED");
      expect(prompt).toContain('terminal_run {"command":"deploy.sh"}');
    });

    it("adds no completed-call section to the first attempt of a goal", async () => {
      goals.create({ title: "Fresh goal", steps: ["Run"], replaceExisting: false });
      await supervisor.tick("fresh");
      expect(String(run.mock.calls[0][0].goal)).not.toContain("ALREADY COMPLETED");
    });
  });

  it("keeps a recurring schedule queued for retry after a failed run (no retry cap)", async () => {
    run.mockResolvedValueOnce({ ...makeResult("", "failed"), error: "Recurring execution failure." });
    config = { autonomy: { enabled: true, tool_policy: { max_retries: 0, retry_backoff_seconds: 5, require_acceptance_contract: false } }, heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } } };
    const task = supervisor.enqueueTask({ title: "Recurring failure", intervalSeconds: 3600 });
    const result = await supervisor.tick("schedule");
    expect(result.status).toBe("idle");
    expect(supervisor.listScheduledTasks().find((item) => item.task_id === task?.task_id)).toMatchObject({ status: "queued", interval_seconds: 3600 });
  });

  it("rate-limits event triggers and keeps event payload hashing stable", () => {
    config = { autonomy: { enabled: true, event_triggers: { max_per_minute: 1, cooldown_seconds: 0 }, tool_policy: { require_acceptance_contract: false } }, heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } } };
    supervisor.addEventTrigger({ eventName: "message:received", title: "Event task" });
    const first = supervisor.triggerEvent("message:received", { b: 2, a: 1 });
    const duplicate = supervisor.triggerEvent("message:received", { a: 1, b: 2 });
    const second = supervisor.triggerEvent("message:received", { a: 3, b: 4 });
    expect(first.triggered).toBe(1);
    expect(duplicate.triggered).toBe(0);
    expect(second.triggered).toBe(0);
    expect(supervisor.listScheduledTasks()).toHaveLength(1);
  });

  it("keeps working when the legacy autonomy.enabled flag is false (autonomy is always on)", async () => {
    config = { autonomy: { enabled: false, tool_policy: { require_acceptance_contract: false } }, heartbeat: { enabled: true, auto_actions: { enabled: true } } };
    goals.create({ title: "Still runs", steps: ["Inspect"], replaceExisting: false });

    const result = await supervisor.tick();

    expect(result.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
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
      // A non-empty memory keeps the first-run bootstrap goal out of the way; bootstrap tests delete this row.
      db.prepare("INSERT INTO memory_chunks(id, region, content, summary, created_at, updated_at) VALUES('seed','long_term','seed','seed','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
      config = {
        autonomy: { enabled: true, tool_policy: { require_acceptance_contract: false } },
        heartbeat: { enabled: true, auto_actions: { enabled: true }, proactive: { enabled: true, decision_interval_seconds: 100 } },
      };
      run.mockResolvedValue(makeResult("Researched one topic and noted the findings."));
    });

    afterEach(() => { spy.mockRestore(); });

    const decide = (trigger: "startup" | "idle") => (supervisor as any).runAmbientDecision(trigger) as Promise<boolean>;

    it("defaults idle LLM decisions on when older or incomplete config omits the setting", () => {
      expect(supervisor.status().proactive_loop).toMatchObject({ enabled: true, startup_decision: true, llm_when_idle: true });
    });

    it("honors an explicit opt-out from idle decisions", () => {
      config.heartbeat.proactive.llm_when_idle = false;
      expect(supervisor.status().proactive_loop.llm_when_idle).toBe(false);
    });

    it("does not run an ambient LLM decision when idle mode is explicitly disabled or paused", async () => {
      config.heartbeat.proactive.llm_when_idle = false;
      expect(await decide("startup")).toBe(false);
      expect(run).not.toHaveBeenCalled();

      config.heartbeat.proactive.llm_when_idle = true;
      supervisor.pause();
      expect(await decide("idle")).toBe(false);
      expect(run).not.toHaveBeenCalled();
      supervisor.resume();
    });

    it("honors startup_decision=false but starts the quiet observation cadence", async () => {
      config.heartbeat.proactive.startup_decision = false;
      const loop = jest.spyOn(supervisor as any, "runLoop").mockResolvedValue(undefined);
      supervisor.start();
      expect((supervisor as any).ambientWakeRequested).toBe(false);
      expect((supervisor as any).ambientLastAt).toBe(nowMs);
      await Promise.resolve();
      await supervisor.stop();
      expect(loop).toHaveBeenCalledTimes(1);
    });

    it("does not treat a proactive notice or another session's assistant reply as the latest user's answer", () => {
      db.exec("DROP TABLE chat_messages");
      db.exec(`CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL, status TEXT, reply_to_message_id TEXT, kind TEXT
      )`);
      const add = db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,status,reply_to_message_id,kind) VALUES(?,?,?,?,?,?,?,?)");
      add.run("user-old", "session-old", "user", "old", "2026-01-01T00:00:00.000Z", "completed", null, "normal");
      add.run("assistant-other", "session-old", "assistant", "old answer", "2026-01-01T00:00:01.000Z", null, "user-old", "normal");
      add.run("user-current", "session-current", "user", "new request", "2026-01-01T00:00:02.000Z", "processing", null, "normal");
      add.run("proactive-notice", "session-current", "assistant", "background update", "2026-01-01T00:00:03.000Z", null, null, "normal");
      expect((supervisor as any).foregroundReplyPending()).toBe(true);
      add.run("assistant-current", "session-current", "assistant", "answer", "2026-01-01T00:00:04.000Z", null, "user-current", "normal");
      db.prepare("UPDATE chat_messages SET status='completed' WHERE id='user-current'").run();
      expect((supervisor as any).foregroundReplyPending()).toBe(false);
    });

    it("does not treat legacy-schema proactive notices or other contexts as a user reply", () => {
      db.exec("DROP TABLE chat_messages");
      db.exec(`CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal', context_id TEXT
      )`);
      const add = db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,kind,context_id) VALUES(?,?,?,?,?,?,?)");
      add.run("user-current", "session-current", "user", "new request", "2026-01-01T00:00:02.000Z", "normal", "ctx-current");
      add.run("proactive-notice", "session-current", "assistant", "background update", "2026-01-01T00:00:03.000Z", "normal", "proactive:progress:notice-1");
      add.run("assistant-other-context", "session-current", "assistant", "other answer", "2026-01-01T00:00:04.000Z", "normal", "ctx-other");
      expect((supervisor as any).foregroundReplyPending()).toBe(true);
      add.run("assistant-current", "session-current", "assistant", "answer", "2026-01-01T00:00:05.000Z", "normal", "ctx-current");
      expect((supervisor as any).foregroundReplyPending()).toBe(false);
    });

    it("lets a configuration wake bypass the quiet interval", async () => {
      await decide("startup");
      expect(run).toHaveBeenCalledTimes(1);
      (supervisor as any).ambientWakeRequested = false;
      (supervisor as any).ambientLastAt = nowMs;
      nowMs += 10_000;
      expect(await decide("idle")).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);

      supervisor.wake({ forceAmbient: true });
      expect(await decide("idle")).toBe(false); // decision ran, but it queued no durable goal
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("immediately schedules the next ambient LLM decision after a completed cycle", async () => {
      expect(await decide("startup")).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
      expect((supervisor as any).ambientWakeRequested).toBe(true);
      expect((supervisor as any).ambientDueInMs((supervisor as any).config())).toBe(0);

      nowMs += 1;
      expect(await decide("idle")).toBe(false);
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("wakes immediately on a meaningful event without waiting for the quiet-environment interval", async () => {
      await decide("startup");
      expect(run).toHaveBeenCalledTimes(1);
      nowMs += 1_000; // well inside the configured 100s quiet-environment cadence
      supervisor.wake();
      expect(await decide("idle")).toBe(false); // a decision ran, but it did not queue a durable goal
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("continues after a no-work ambient answer without waiting for the quiet interval", async () => {
      run.mockResolvedValue(makeResult("No useful work is available right now."));
      expect(await decide("startup")).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
      expect((supervisor as any).ambientWakeRequested).toBe(true);
      nowMs += 1;
      expect(await decide("idle")).toBe(false);
      expect(run).toHaveBeenCalledTimes(2);
      expect((supervisor as any).ambientWakeRequested).toBe(true);
    });

    it("does not let a forced configuration wake bypass provider failure backoff", async () => {
      (supervisor as any).failureStreak = 1;
      (supervisor as any).lastFailure = { kind: "network", message: "temporary outage", at: new Date(nowMs).toISOString() };
      supervisor.wake({ forceAmbient: true });
      expect(await decide("idle")).toBe(false);
      expect(run).not.toHaveBeenCalled();
      nowMs += 3_000;
      await decide("idle");
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("does not require fabricated work when no useful action is available", async () => {
      await decide("startup");
      const prompt = String((run.mock.calls[0][0] as { goal: string }).goal);
      expect(prompt).not.toMatch(/NO_ACTION/);
      expect(prompt).toMatch(/If there is genuinely no useful work/);
      expect(prompt).toMatch(/wait for the next environment\/event observation/);
    });

    it("treats the literal text NO_ACTION as ordinary inline work, not as a special outcome", async () => {
      run.mockResolvedValue(makeResult("NO_ACTION"));
      await decide("startup");
      expect(run).toHaveBeenCalledTimes(1); // no retry: it is non-empty text
    });

    it("asks once more after an empty reply, then immediately starts another ambient cycle", async () => {
      run.mockResolvedValue(makeResult(""));
      await decide("startup");
      expect(run).toHaveBeenCalledTimes(2);
      const second = String((run.mock.calls[1][0] as { goal: string }).goal);
      expect(second).toMatch(/previous reply was empty/);
      expect((run.mock.calls[1][0] as { runId: string }).runId).not.toBe((run.mock.calls[0][0] as { runId: string }).runId);
      nowMs += 10_000;
      await decide("idle");
      expect(run).toHaveBeenCalledTimes(4); // strict retry plus the next immediate cycle
    });

    it("uses a new run id for every cycle even when the world state is unchanged", async () => {
      await decide("startup");
      nowMs += 100_000;
      await decide("idle");
      const ids = run.mock.calls.map((call) => (call[0] as { runId: string }).runId);
      expect(new Set(ids).size).toBe(2);
    });

    it("skips an idle decision when a scheduled task is due within 30 seconds", async () => {
      supervisor.enqueueTask({ title: "Soon", dueAt: "2026-01-01T00:00:20.000Z" });
      expect(await decide("startup")).toBe(false);
      expect(run).not.toHaveBeenCalled();
    });

    it("still runs when the next scheduled task is far away", async () => {
      supervisor.enqueueTask({ title: "Later", dueAt: "2026-01-01T01:00:00.000Z" });
      await decide("startup");
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("does not count future retry-wait tasks as runnable work that blocks idle activation", () => {
      supervisor.enqueueTask({ title: "Retry after backoff", dueAt: "2026-01-01T00:00:00.000Z" });
      const task = db.prepare("SELECT task_id FROM autonomy_task_queue ORDER BY task_id DESC LIMIT 1").get() as { task_id: number };
      db.prepare("UPDATE autonomy_task_queue SET status='queued',retry_at=? WHERE task_id=?")
        .run("2026-01-01T00:00:30.000Z", task.task_id);
      expect((supervisor as any).hasRunnableAutonomyTask()).toBe(false);

      db.prepare("UPDATE autonomy_task_queue SET retry_at=? WHERE task_id=?")
        .run("2025-12-31T23:59:59.000Z", task.task_id);
      expect((supervisor as any).hasRunnableAutonomyTask()).toBe(true);
    });

    describe("curiosity cycle, drives and first-run bootstrap", () => {
      let workspace: string;
      const write = (rel: string, text: string) => { const f = path.join(workspace, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
      const build = (tools: ToolRegistry = makeTools(), releaseInteractiveResources?: (runId: string) => void) => {
        supervisor = new AutonomousSupervisor({
          db, agent: { run }, tools, activeRunCount, getConfig: () => withLegacyProactive(config), workspaceRoot: workspace,
          log: (message) => logs.push(message), now: () => new Date(nowMs).toISOString(),
          ...(releaseInteractiveResources ? { releaseInteractiveResources } : {}),
        });
      };
      const decide = (trigger: "startup" | "idle") => (supervisor as any).runAmbientDecision(trigger) as Promise<boolean>;
      const lastPrompt = () => String((run.mock.calls[run.mock.calls.length - 1][0] as { goal: string }).goal);
      const proactive = (extra: Record<string, unknown> = {}) => ({ enabled: true, decision_interval_seconds: 100, ...extra });
      const setConfig = (proactiveConfig: Record<string, unknown>, tool_policy: Record<string, unknown> = {}) => {
        config = { autonomy: { enabled: true, tool_policy: { require_acceptance_contract: false, ...tool_policy } }, heartbeat: { enabled: true, auto_actions: { enabled: true }, proactive: proactiveConfig } };
      };
      const driveFile = (extra = "") => "---\ndrives:\n  - name: learn_environment\n    description: \"Learn my surroundings\"\n    urge_per_hour: 0.5\n    max_urge: 10\n  - name: satisfy_curiosity\n    description: \"Explore a topic\"\n    urge_per_hour: 2\n    max_urge: 8\n" + extra + "---\n";
      const propose = (args: Record<string, unknown>) => {
        let out: unknown; let error: unknown;
        run.mockImplementationOnce(async (request: { tools: ToolRegistry }) => {
          try { out = await request.tools.get("autonomy_propose_goal")!.execute(args, {} as never); } catch (e) { error = e; }
          return makeResult("Proposed.");
        });
        return async () => { nowMs += 200_000; await decide("idle"); return { out: out as { created?: boolean } | undefined, error: error as Error | undefined }; };
      };
      const curiosityGoal = (n: number) => ({
        title: `Explore topic ${n}`, description: "d", curiosity: true,
        acceptance: { checks: [{ type: "file_exists", path: `identity/memory/discoveries/2026-01-01-topic-${n}.md` }, { type: "file_contains", path: `identity/memory/discoveries/2026-01-01-topic-${n}.md`, text: "Findings" }] },
      });

      beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-curiosity-")); setConfig(proactive()); });
      afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

      it("puts INTERESTS and earlier discoveries in the idle prompt and asks for a curiosity cycle", async () => {
        write("identity/INTERESTS.md", "# INTERESTS\n\n- Quantum error correction\n- Home espresso machines\n");
        build();
        db.prepare("INSERT INTO autonomy_discoveries(created_at, title, title_hash, summary, importance) VALUES(?,?,?,?,?)").run("2025-12-31T00:00:00.000Z", "Old finding about espresso", "h", "s", 3);
        await decide("startup");
        const prompt = lastPrompt();
        expect(prompt).toMatch(/Quantum error correction/);
        expect(prompt).toMatch(/Old finding about espresso/);
        expect(prompt).toMatch(/curiosity cycle/);
        expect(prompt).toMatch(/identity\/memory\/discoveries\//);
        expect(prompt).toMatch(/autonomy_share_discovery/);
        expect(prompt).not.toMatch(/Do not generate routine chatter/);
      });

      it("creates curiosity goals with source curiosity at priority 9", async () => {
        build();
        const go = propose(curiosityGoal(1));
        await decide("startup");
        await go();
        expect(db.prepare("SELECT source, priority FROM pursue_goals WHERE title='Explore topic 1'").get()).toEqual({ source: "curiosity", priority: 9 });
      });

      it("rejects a curiosity goal that does not name a result file under identity/memory/discoveries/", async () => {
        build();
        await decide("startup");
        const go = propose({ title: "Explore topic X", description: "d", curiosity: true, acceptance: { checks: [{ type: "file_exists", path: "autonomy/other.md" }] } });
        const { error } = await go();
        expect(error?.message).toMatch(/identity\/memory\/discoveries/);
      });

      it("does not impose arbitrary open-goal or daily proposal limits", async () => {
        setConfig(proactive({ curiosity: { max_open: 1, max_per_day: 1 }, proposal_limits: { max_open: 1, max_per_day: 1 } }));
        build();
        await decide("startup");
        expect((await propose(curiosityGoal(1))()).error).toBeUndefined();
        expect((await propose(curiosityGoal(2))()).error).toBeUndefined();
        const ordinaryOne = propose({ title: "Tidy the notes", description: "d", acceptance: { checks: [{ type: "tool_called", name: "file_write", status: "succeeded" }] } });
        const ordinaryTwo = propose({ title: "Review the notes", description: "d", acceptance: { checks: [{ type: "tool_called", name: "file_write", status: "succeeded" }] } });
        expect((await ordinaryOne()).error).toBeUndefined();
        expect((await ordinaryTwo()).error).toBeUndefined();
        expect(Number(db.prepare("SELECT COUNT(*) AS c FROM pursue_goals WHERE status IN ('pending','active')").get()?.c)).toBe(4);
      });

      it("reads DRIVES.md front-matter and shows urge growing with time, capped at max_urge, strongest first", async () => {
        write("identity/DRIVES.md", driveFile());
        build();
        await decide("startup");
        expect(lastPrompt()).toMatch(/- learn_environment: urge 0\.0\/10 - Learn my surroundings/);

        nowMs += 4 * 3_600_000; // learn: 0.5*4 = 2.0 ; curiosity: 2*4 = 8 (cap 8)
        await decide("idle");
        const prompt = lastPrompt();
        expect(prompt).toMatch(/- satisfy_curiosity: urge 8\.0\/8/);
        expect(prompt).toMatch(/- learn_environment: urge 2\.0\/10/);
        expect(prompt.indexOf("- satisfy_curiosity:")).toBeLessThan(prompt.indexOf("- learn_environment:"));
        expect(prompt).toMatch(/autonomy_drive_done/);
      });

      it("resets a drive's urge through autonomy_drive_done and counts how often it was pursued", async () => {
        write("identity/DRIVES.md", driveFile());
        build();
        await decide("startup");
        nowMs += 4 * 3_600_000;
        run.mockImplementationOnce(async (request: { tools: ToolRegistry }) => {
          await request.tools.get("autonomy_drive_done")!.execute({ name: "satisfy_curiosity", outcome: "Read about a new tool." }, {} as never);
          return makeResult("Done.");
        });
        await decide("idle");
        expect(db.prepare("SELECT times_pursued, last_outcome FROM autonomy_drives WHERE name='satisfy_curiosity'").get()).toEqual({ times_pursued: 1, last_outcome: "Read about a new tool." });
        nowMs += 100_000; // 100s after being pursued: 2 * 100/3600 = 0.06
        await decide("idle");
        expect(lastPrompt()).toMatch(/- satisfy_curiosity: urge 0\.[01]\/8/);
      });

      it("rejects an unknown drive name", async () => {
        write("identity/DRIVES.md", driveFile());
        build();
        let error: Error | undefined;
        run.mockImplementationOnce(async (request: { tools: ToolRegistry }) => {
          try { await request.tools.get("autonomy_drive_done")!.execute({ name: "world-domination", outcome: "x" }, {} as never); } catch (e) { error = e as Error; }
          return makeResult("Done.");
        });
        await decide("startup");
        expect(error?.message).toMatch(/Unknown drive/);
      });

      describe("first-run bootstrap", () => {
        beforeEach(() => { db.prepare("DELETE FROM memory_chunks").run(); });

        it("creates the environment-exploration goal itself on an empty install, instead of asking the model", async () => {
          build();
          expect(await decide("startup")).toBe(true);
          expect(run).not.toHaveBeenCalled();
          const row = db.prepare("SELECT title, source, priority, acceptance_contract FROM pursue_goals").get() as { title: string; source: string; priority: number; acceptance_contract: string };
          expect(row).toMatchObject({ title: "Explore my environment", source: "drive", priority: 9 });
          expect(JSON.parse(row.acceptance_contract).checks).toEqual([{ type: "file_exists", path: "identity/memory/environment.md" }]);
        });

        it("requires a screenshot only when the live computer capability probe confirms it is available", async () => {
          setConfig(proactive(), { allow_computer_use: true });
          const tools = makeTools();
          tools.register({ name: "computer_screenshot", description: "s", risk: "read", parameters: { type: "object", properties: {} }, approval: "auto", execute: async () => ({ ok: true }) });
          tools.register({ name: "computer_capabilities", description: "capabilities", risk: "read", parameters: { type: "object", properties: {} }, approval: "auto", execute: async () => JSON.stringify({ ok: true, data: { actions: { screenshot: true, listProcesses: true } } }) });
          build(tools);
          await decide("startup");
          const row = db.prepare("SELECT acceptance_contract,description FROM pursue_goals").get() as { acceptance_contract: string; description: string };
          expect(JSON.parse(row.acceptance_contract).checks).toContainEqual({ type: "tool_called", name: "computer_screenshot", status: "succeeded" });
          expect(row.description).toContain("take a screenshot");
          expect(row.description).toContain("list running processes");
        });

        it("does not make desktop evidence mandatory when the host capability cannot be verified", async () => {
          setConfig(proactive(), { allow_computer_use: true });
          const tools = makeTools();
          tools.register({ name: "computer_screenshot", description: "s", risk: "read", parameters: { type: "object", properties: {} }, approval: "auto", execute: async () => ({ ok: true }) });
          tools.register({ name: "computer_capabilities", description: "capabilities", risk: "read", parameters: { type: "object", properties: {} }, approval: "auto", execute: async () => JSON.stringify({ ok: true, data: { actions: { screenshot: false, listProcesses: true } } }) });
          build(tools);
          await decide("startup");
          const row = db.prepare("SELECT acceptance_contract,description FROM pursue_goals").get() as { acceptance_contract: string; description: string };
          expect(JSON.parse(row.acceptance_contract).checks).not.toContainEqual({ type: "tool_called", name: "computer_screenshot", status: "succeeded" });
          expect(row.description).not.toContain("take a screenshot");
          expect(row.description).toContain("list running processes");
        });

        it("times out a hung capability probe and still creates the bootstrap goal", async () => {
          setConfig(proactive({ observation_timeout_ms: 1_000 }), { allow_computer_use: true });
          const tools = makeTools();
          let probeSignal: AbortSignal | undefined;
          tools.register({ name: "computer_screenshot", description: "s", risk: "read", parameters: { type: "object", properties: {} }, approval: "auto", execute: async () => ({ ok: true }) });
          tools.register({
            name: "computer_capabilities", description: "capabilities", risk: "read", parameters: { type: "object", properties: {} }, approval: "auto",
            execute: async (_input, context) => { probeSignal = context.signal; return new Promise(() => {}); },
          });
          build(tools);
          expect(await decide("startup")).toBe(true);
          expect(probeSignal?.aborted).toBe(true);
          const row = db.prepare("SELECT acceptance_contract FROM pursue_goals").get() as { acceptance_contract: string };
          expect(JSON.parse(row.acceptance_contract).checks).toEqual([{ type: "file_exists", path: "identity/memory/environment.md" }]);
        });

        it("does not repeat once it exists, and not when memory is not empty", async () => {
          build();
          await decide("startup");
          nowMs += 200_000;
          await decide("startup");
          expect(db.prepare("SELECT COUNT(*) c FROM pursue_goals WHERE source='drive'").get()).toEqual({ c: 1 });

          db.prepare("DELETE FROM pursue_goals").run();
          db.prepare("DELETE FROM autonomy_drives").run();
          db.prepare("INSERT INTO memory_chunks(id, region, content, summary, created_at, updated_at) VALUES('m1','long_term','x','x','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
          nowMs += 200_000;
          await decide("startup");
          expect(db.prepare("SELECT COUNT(*) c FROM pursue_goals").get()).toEqual({ c: 0 });
        });
      });

      it("captures a fresh read-only computer snapshot and keeps acting tools out of the ambient lane", async () => {
        const tools = makeTools();
        const computerObserve = jest.fn(async () => ({ active_window: "Code Editor", visible_elements: ["Miki project"] }));
        for (const name of ["computer_observe", "computer_screenshot", "computer_list_processes", "computer_list_windows", "computer_click_at"]) {
          tools.register({ name, description: name, risk: "read", parameters: { type: "object", properties: {} }, approval: "auto", execute: name === "computer_observe" ? computerObserve : async () => ({ ok: true }) });
        }
        const offered = async (proactiveConfig: Record<string, unknown>, policy: Record<string, unknown>, releaseInteractiveResources?: (runId: string) => void) => {
          setConfig(proactiveConfig, policy);
          build(tools, releaseInteractiveResources);
          nowMs += 200_000;
          await decide("startup");
          return (run.mock.calls[run.mock.calls.length - 1][0] as { tools: ToolRegistry }).tools;
        };
        const releaseInteractiveResources = jest.fn();
        const on = await offered(proactive(), {
          allow_computer_use: true,
          allow_browser: true,
          capability_profile: "operator",
          auto_approve_all: true,
          allowed_tools: ["file_write", "terminal_run"],
          allowed_external_side_effect_tools: ["computer_click_at"],
        }, releaseInteractiveResources);
        for (const name of ["computer_observe", "computer_screenshot", "computer_list_processes", "computer_list_windows"]) expect(on.has(name)).toBe(true);
        expect(computerObserve).toHaveBeenCalledWith(
          { active_only: true, max_elements: 60 },
          expect.objectContaining({ runId: expect.stringContaining("autonomy-observer-"), signal: expect.any(AbortSignal) }),
        );
        expect(String((run.mock.calls[run.mock.calls.length - 1][0] as { goal: string }).goal)).toContain("Code Editor");
        expect(on.has("computer_click_at")).toBe(false); // acting tools stay goal-only even in no-confirm mode
        expect(on.has("file_write")).toBe(false);
        expect(on.has("memory_add")).toBe(false);
        expect(on.has("terminal_run")).toBe(false);
        expect(releaseInteractiveResources).toHaveBeenCalledWith(expect.stringContaining("autonomy-observer-"));
        expect(releaseInteractiveResources).toHaveBeenCalledWith(expect.stringContaining("autonomy-ambient-"));
        expect((await offered(proactive({ observe_computer: false }), { allow_computer_use: true })).has("computer_screenshot")).toBe(false);
        expect((await offered(proactive(), {})).has("computer_screenshot")).toBe(false);
      });

      it("runs a scheduled/user goal before a self-proposed one, whatever the creation order", async () => {
        build();
        const checks = [{ type: "file_exists", path: "identity/memory/x.md" }];
        const mk = (title: string, priority: number, source: string) => goals.create({ title, description: "d", priority, source, acceptance: { mode: "all", checks }, replaceExisting: false } as never).id;
        const running = mk("Already running", 5, "user");
        const selfProposed = mk("Self proposed", 9, "ambient_proposal");
        const scheduled = mk("Due cron task", 5, "cron");
        goals.update(running, { status: "completed", statusReason: "done" });
        await supervisor.tick("schedule");
        const status = (id: number) => (db.prepare("SELECT status FROM pursue_goals WHERE id=?").get(id) as { status: string }).status;
        expect(status(scheduled)).not.toBe("pending");
        expect(status(selfProposed)).toBe("pending");
      });

      it("starts self-directed goals without an inactivity countdown by default", async () => {
        build();
        db.prepare("INSERT INTO chat_messages(id, session_id, role, content, created_at) VALUES(?,?,?,?,?)")
          .run("recent-user", "s", "user", "hello", new Date(nowMs).toISOString());
        db.prepare("INSERT INTO chat_messages(id, session_id, role, content, created_at) VALUES(?,?,?,?,?)")
          .run("recent-assistant", "s", "assistant", "hello back", new Date(nowMs + 1).toISOString());
        const goalId = goals.create({ title: "Explore now", description: "d", priority: 9, source: "curiosity", acceptance: { mode: "all", checks: [{ type: "file_exists", path: "identity/memory/x.md" }] }, replaceExisting: false } as never).id;
        await supervisor.tick("always-active-idle");
        expect((db.prepare("SELECT status FROM pursue_goals WHERE id=?").get(goalId) as { status: string }).status).not.toBe("pending");
      });

      describe("legacy inactivity override (idle_after_seconds)", () => {
        const addChat = (minutesAgo: number) => db.prepare("INSERT INTO chat_messages(id, session_id, role, content, created_at) VALUES(?,?,?,?,?)").run(`u${minutesAgo}`, "s", "user", "hi", new Date(nowMs - minutesAgo * 60_000).toISOString());
        const goalStatus = (id: number) => (db.prepare("SELECT status FROM pursue_goals WHERE id=?").get(id) as { status: string }).status;
        const mk = (source: string, title: string) => goals.create({ title, description: "d", priority: 9, source, acceptance: { mode: "all", checks: [{ type: "file_exists", path: "identity/memory/x.md" }] }, replaceExisting: false } as never).id;

        it("supports an explicit legacy idle gate when configured", async () => {
          setConfig(proactive({ idle_after_seconds: 600 }));
          build();
          addChat(2);
          const curiosity = mk("curiosity", "Explore a topic");
          const drive = mk("drive", "Learn something");
          const runsOf = (id: number) => (db.prepare("SELECT COUNT(*) c FROM autonomy_goal_runs WHERE goal_id=?").get(id) as { c: number }).c;
          expect((await supervisor.tick("schedule")).status).toBe("idle");
          expect([runsOf(curiosity), runsOf(drive), goalStatus(drive)]).toEqual([0, 0, "pending"]);

          nowMs += 9 * 60_000; // 11 minutes since the message
          await supervisor.tick("schedule");
          expect(runsOf(curiosity)).toBeGreaterThan(0);
        });

        it("never holds back a user goal while the user is chatting", async () => {
          setConfig(proactive({ idle_after_seconds: 600 }));
          build();
          addChat(1);
          const userGoal = mk("user", "Do what the user asked");
          await supervisor.tick("schedule");
          expect(goalStatus(userGoal)).not.toBe("pending");
        });
      });
    });

    it("forces self-proposed goals to the lowest priority so they never outrank scheduled work", async () => {
      run.mockImplementationOnce(async (request: { tools: ToolRegistry }) => {
        const tool = request.tools.get("autonomy_propose_goal")!;
        await tool.execute({
          title: "Explore a topic", description: "d", priority: 0,
          acceptance: { checks: [{ type: "tool_called", name: "file_write", status: "succeeded" }] },
        }, {} as never);
        return makeResult("Queued a goal.");
      });
      await decide("startup");
      const goal = db.prepare("SELECT priority, source FROM pursue_goals WHERE title='Explore a topic'").get() as { priority: number; source: string };
      expect(goal).toEqual({ priority: 9, source: "ambient_proposal" });
    });

    it("returns to the base interval as soon as the world state changes", async () => {
      await decide("startup");
      nowMs += 100_000;
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES('m1','miki-main-chat','user','hello','2026-01-01T00:00:00Z')").run();
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES('a1','miki-main-chat','assistant','answered','2026-01-01T00:00:01Z')").run();
      await decide("idle");
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("starts a fresh memory-aware LLM decision inside the quiet interval", async () => {
      await decide("startup");
      nowMs += 10_000;
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES('m1','miki-main-chat','user','hello','2026-01-01T00:00:00Z')").run();
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES('a1','miki-main-chat','assistant','answered','2026-01-01T00:00:01Z')").run();
      await decide("idle");
      expect(run).toHaveBeenCalledTimes(2);
      expect(String((run.mock.calls[1][0] as { goal: string }).goal)).toMatch(/ALREADY been answered/);
    });

    it("suppresses a recent foreground request when the ambient loop starts", async () => {
      const insertedAt = new Date(nowMs).toISOString();
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)")
        .run("startup-foreground-1", "miki-main-chat", "user", "inspect the project", insertedAt);
      await decide("startup");
      expect(run).not.toHaveBeenCalled();
    });

    it("does not start while a foreground request is pending and resumes with fresh context after restart", async () => {
      const insertedAt = new Date(nowMs).toISOString();
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)")
        .run("foreground-1", "miki-main-chat", "user", "list the workspace files", insertedAt);
      await decide("idle");
      expect(run).not.toHaveBeenCalled();
      // The foreground assistant answer changes the chat fingerprint while the
      // interaction is still recent; the suppression row must follow that final state.
      nowMs += 2_000;
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)")
        .run("foreground-answer-1", "miki-main-chat", "assistant", "Here are the workspace files.", new Date(nowMs).toISOString());
      await decide("idle");
      expect(run).not.toHaveBeenCalled();

      // A fresh supervisor has no in-memory cooldown, but must retain the SQLite guard.
      const restarted = new AutonomousSupervisor({
        db, agent: { run }, tools: makeTools(), activeRunCount: jest.fn().mockReturnValue(0),
        getConfig: () => withLegacyProactive(config), log: () => undefined, now: () => new Date(nowMs).toISOString(),
      });
      nowMs += 20_000; // a restarted supervisor resumes autonomously before the old quiet interval expires
      expect(await (restarted as any).runAmbientDecision("idle")).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
      expect(String((run.mock.calls[0][0] as { goal: string }).goal)).toMatch(/ALREADY been answered/);
    });

    it("continues immediately after the answered request and on a fresh restart", async () => {
      const t0 = nowMs;
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)")
        .run("u1", "miki-main-chat", "user", "list the workspace files", new Date(t0).toISOString());
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)")
        .run("a1", "miki-main-chat", "assistant", "Here are the files.", new Date(t0 + 1_000).toISOString());
      nowMs = t0 + 2_000;
      await decide("idle");
      expect(run).toHaveBeenCalledTimes(1);
      expect(String((run.mock.calls[0][0] as { goal: string }).goal)).toMatch(/ALREADY been answered/);
      nowMs = t0 + 10 * 60_000; // ten minutes later, chat/goals/tasks/memory unchanged
      const restarted = new AutonomousSupervisor({
        db, agent: { run }, tools: makeTools(), activeRunCount: jest.fn().mockReturnValue(0),
        getConfig: () => withLegacyProactive(config), log: () => undefined, now: () => new Date(nowMs).toISOString(),
      });
      await (restarted as any).runAmbientDecision("idle");
      expect(run).toHaveBeenCalledTimes(2);
      const prompt = String((run.mock.calls[1][0] as { goal: string }).goal);
      expect(prompt).toMatch(/ALREADY been answered/);
    });

    it("lets the ambient run's policy allow autonomy_propose_goal (not blocked by the allowlist)", async () => {
      await decide("startup");
      expect(run).toHaveBeenCalledTimes(1);
      const call = run.mock.calls[0][0] as { approvalPolicy: { decide: (tool: unknown, input: Record<string, unknown>) => { mode: string; reason?: string } } };
      const decision = call.approvalPolicy.decide(
        { name: "autonomy_propose_goal", description: "", risk: "config_write", approval: "auto", parameters: { type: "object", properties: {} }, execute: async () => ({}) },
        { title: "t", description: "d", acceptance: { checks: [] } },
      );
      expect(decision.reason ?? "").not.toMatch(/explicit capability allowlist/);
      expect(decision.mode).not.toBe("block");
    });

    it("does not report removed backoff fields in the status", async () => {
      await decide("startup");
      expect(supervisor.status().proactive_loop).not.toHaveProperty("no_action_streak");
      expect(supervisor.status().proactive_loop).not.toHaveProperty("max_decision_interval_seconds");
    });
  });

  describe("parallel goal runner", () => {
    const makeSup = (maxConcurrentTasks?: number) => new AutonomousSupervisor({
      db, agent: { run }, tools: makeTools(), activeRunCount,
      getConfig: () => withLegacyProactive({ autonomy: { enabled: true, tool_policy: { require_acceptance_contract: false } }, heartbeat: { enabled: true }, ...(maxConcurrentTasks ? { concurrency: { maxConcurrentTasks } } : {}) }),
      log: (m) => logs.push(m), now: () => new Date().toISOString(),
    });

    it("runs two goals at the same time when maxConcurrentTasks allows, each with its own lease", async () => {
      const sup = makeSup(2);
      goals.create({ title: "Goal A", replaceExisting: false });
      goals.create({ title: "Goal B", replaceExisting: false });
      const release: Array<() => void> = [];
      let concurrent = 0; let peak = 0;
      run.mockImplementation(() => new Promise((resolve) => {
        concurrent += 1; peak = Math.max(peak, concurrent);
        release.push(() => { concurrent -= 1; resolve(makeResult("done")); });
      }));
      const first = sup.tick("heartbeat");
      await new Promise((r) => setTimeout(r, 20));
      const second = sup.tick("heartbeat");
      await new Promise((r) => setTimeout(r, 20));
      expect(peak).toBe(2);
      const claims = db.prepare("SELECT COUNT(*) c FROM autonomy_goal_claims").get() as { c: number };
      expect(claims.c).toBe(2);
      const third = await sup.tick("heartbeat");
      expect(third.status).toBe("busy");
      release.forEach((fn) => fn());
      await Promise.all([first, second]);
    });

    it("keeps one goal at a time by default", async () => {
      const sup = makeSup();
      goals.create({ title: "Goal A", replaceExisting: false });
      goals.create({ title: "Goal B", replaceExisting: false });
      let release: () => void = () => undefined;
      run.mockImplementation(() => new Promise((resolve) => { release = () => resolve(makeResult("done")); }));
      const first = sup.tick("heartbeat");
      await new Promise((r) => setTimeout(r, 20));
      expect((await sup.tick("heartbeat")).status).toBe("busy");
      release();
      await first;
    });
  });

  describe("heartbeat checklist tasks", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-hb-"));
      fs.mkdirSync(path.join(dir, "identity"));
      config = { autonomy: { enabled: true, tool_policy: { require_acceptance_contract: false } }, heartbeat: { enabled: true, checklist_path: "identity/HEARTBEAT.md", checklist_tasks: { interval_seconds: 120 } } };
      supervisor = new AutonomousSupervisor({
        db, agent: { run }, tools: makeTools(), activeRunCount, workspaceRoot: dir,
        getConfig: () => withLegacyProactive(config), log: (m) => logs.push(m), now: () => "2026-01-01T00:00:00.000Z",
      });
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("queues one recurring task per checklist line, idempotently, skipping comments and [noop]", () => {
      fs.writeFileSync(path.join(dir, "identity/HEARTBEAT.md"), "# c\n- [notify] Check stuck tasks\n- [noop] ignore me\n- Review verifier flags\n");
      (supervisor as any).syncHeartbeatTasks((supervisor as any).config());
      const tasks = supervisor.listScheduledTasks(20);
      expect(tasks.map((t: any) => t.title).sort()).toEqual(["Heartbeat: Check stuck tasks", "Heartbeat: Review verifier flags"]);
      expect(tasks.every((t: any) => t.interval_seconds === 120)).toBe(true);
      (supervisor as any).heartbeatTasksSyncedAt = 0;
      (supervisor as any).syncHeartbeatTasks((supervisor as any).config());
      expect(supervisor.listScheduledTasks(20)).toHaveLength(2);
    });

    it("keeps checklist scheduling enabled when acceptance contracts are required", () => {
      config = {
        autonomy: { enabled: true, tool_policy: { require_acceptance_contract: true, safe_write_roots: ["autonomy", "identity/memory"] } },
        heartbeat: { enabled: true, checklist_path: "identity/HEARTBEAT.md", checklist_tasks: { enabled: true, interval_seconds: 120 } },
      };
      fs.writeFileSync(path.join(dir, "identity/HEARTBEAT.md"), "- [tool] Verify the local queue\n");

      (supervisor as any).syncHeartbeatTasks((supervisor as any).config());

      expect(supervisor.listScheduledTasks(20).map((task: any) => task.title)).toEqual(["Heartbeat: Verify the local queue"]);
      expect(logs.some((message) => message.includes("no configured safe_write_roots"))).toBe(false);
    });

    it("requires unique file evidence before completing a strict checklist run", async () => {
      config = {
        autonomy: { enabled: true, tool_policy: { require_acceptance_contract: true, safe_write_roots: ["autonomy", "identity/memory"] } },
        heartbeat: { enabled: true, checklist_path: "identity/HEARTBEAT.md", checklist_tasks: { enabled: true, interval_seconds: 120 } },
      };
      fs.writeFileSync(path.join(dir, "identity/HEARTBEAT.md"), "- [tool] Verify the local queue\n");
      run.mockImplementation(async (request: { goal?: string }) => {
        const prompt = String(request.goal ?? "");
        const reportPath = /After performing this check, write a concise report to ([^\n]+)\. Create its parent directory if needed\./.exec(prompt)?.[1];
        const marker = /Include this exact marker on its own line: ([^\n]+)/.exec(prompt)?.[1];
        expect(reportPath).toBeTruthy();
        expect(marker).toMatch(/^MIKI_HEARTBEAT_CHECK_RUN_ID: [0-9a-f-]+$/i);
        const absoluteReportPath = path.join(dir, reportPath!);
        fs.mkdirSync(path.dirname(absoluteReportPath), { recursive: true });
        fs.writeFileSync(absoluteReportPath, `Inspection: queue checked.\n${marker}\n`);
        return makeResult("Checklist evidence saved.");
      });

      const result = await supervisor.tick("checklist-test");

      expect(result.status).toBe("completed");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0].goal).toContain("MANDATORY CHECKLIST RUN EVIDENCE");
      const goal = goals.get(result.goalId!);
      expect(goal?.acceptance_contract).toContain("MIKI_HEARTBEAT_CHECK_RUN_ID:");
      const contract = JSON.parse(goal!.acceptance_contract!) as { checks: Array<{ path: string; text: string }> };
      const report = fs.readFileSync(path.join(dir, contract.checks[0].path), "utf8");
      expect(report).toContain(contract.checks[0].text);
      expect(contract.checks[0].path).toContain("heartbeat-checks/");
    });

    it("cancels the task when its line is removed from the checklist", () => {
      const file = path.join(dir, "identity/HEARTBEAT.md");
      fs.writeFileSync(file, "- Check A\n- Check B\n");
      (supervisor as any).syncHeartbeatTasks((supervisor as any).config());
      fs.writeFileSync(file, "- Check A\n");
      (supervisor as any).heartbeatTasksSyncedAt = 0;
      (supervisor as any).syncHeartbeatTasks((supervisor as any).config());
      const byTitle = Object.fromEntries(supervisor.listScheduledTasks(20).map((t: any) => [t.title, t.status]));
      expect(byTitle["Heartbeat: Check A"]).toBe("scheduled");
      expect(byTitle["Heartbeat: Check B"]).toBe("cancelled");
    });
  });

  describe("error handling", () => {
    let nowMs: number;
    let spy: jest.SpyInstance;
    let notes: Array<{ text?: string; kind?: string }>;
    let notify: jest.Mock;

    const failed = (error: string) => ({ ...makeResult("", "failed"), error });
    it("re-plans after a model describes a blocker instead of treating wording as a terminal signal", async () => {
      config = { autonomy: { enabled: true, tool_policy: { require_acceptance_contract: true, safe_write_roots: ["autonomy"] } }, heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } } };
      const goal = goals.create({
        title: "Requires unavailable capability",
        steps: ["Proceed"],
        acceptance: { mode: "all", checks: [{ type: "tool_called", name: "file_write", status: "succeeded" }] },
        replaceExisting: false,
      });
      run.mockResolvedValueOnce(makeResult("The required account permission is unavailable; another permission path may be possible."));
      const outcome = await supervisor.tick("blocked-model-test");
      expect(outcome.status).toBe("idle");
      expect(goals.get(goal.id)?.status).toBe("pending");
      expect(db.prepare("SELECT status,next_retry_at FROM autonomy_goal_runs WHERE goal_id=?").get(goal.id)).toMatchObject({ status: "retry_wait" });
      expect(Number((db.prepare("SELECT COUNT(*) AS count FROM autonomy_goal_replans WHERE goal_id=?").get(goal.id) as { count: number }).count)).toBe(1);
    });
    const build = () => new AutonomousSupervisor({
      db, agent: { run }, tools: makeTools(), activeRunCount, getConfig: () => withLegacyProactive(config),
      log: (message) => logs.push(message), now: () => new Date(nowMs).toISOString(), notify,
    });
    const decide = (trigger: "startup" | "idle") => (supervisor as any).runAmbientDecision(trigger) as Promise<boolean>;

    beforeEach(() => {
      nowMs = Date.parse("2026-01-01T00:00:00.000Z");
      spy = jest.spyOn(Date, "now").mockImplementation(() => nowMs);
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_chunks (id TEXT PRIMARY KEY, region TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      `);
      // A non-empty memory keeps the first-run bootstrap goal out of the way; bootstrap tests delete this row.
      db.prepare("INSERT INTO memory_chunks(id, region, content, summary, created_at, updated_at) VALUES('seed','long_term','seed','seed','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
      config = {
        autonomy: { enabled: true, tool_policy: { require_acceptance_contract: false } },
        heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 }, proactive: { enabled: true, decision_interval_seconds: 900, failure_threshold: 3, failure_backoff_base_seconds: 2, failure_backoff_max_seconds: 12 } },
      };
      notes = [];
      notify = jest.fn(async (n: { text?: string; kind?: string }) => {
        notes.push(n);
        return {
          delivered: 1,
          dashboard: { attempted: 1, delivered: 1, failed: 0 },
          channels: { attempted: 0, delivered: 0, queued: 0, failed: 0 },
          queued: 0,
          failures: [],
        };
      });
      supervisor = build();
    });

    afterEach(() => spy.mockRestore());

    describe("autonomy_share_discovery (server-side gating)", () => {
      const share = async (args: Record<string, unknown>, stepMs = 1_300_000) => {
        let out: unknown;
        run.mockImplementationOnce(async (request: { tools: ToolRegistry }) => {
          out = await request.tools.get("autonomy_share_discovery")!.execute(args, {} as never);
          return makeResult("Shared.");
        });
        nowMs += stepMs; // past the idle-decision interval (default 1300s clears the interval but is still inside the 30-minute gap)
        await (supervisor as any).runAmbientDecision("idle");
        return out as { saved: boolean; notified: boolean; queued?: boolean; id: number; reason: string };
      };
      const discoveryEvents = () => (notify.mock.calls as Array<[{ event?: Record<string, unknown>; kind?: string; text?: string }]>).map((c) => c[0]).filter((n) => n.event?.type === "discovery_shared");
      const base = { summary: "A smaller model now fits the machine and runs twice as fast.", why_interesting: "It changes what I can run locally.", importance: 4 };

      it("can send a meaningful proactive message without a user chat turn", async () => {
        let out: unknown;
        run.mockImplementationOnce(async (request: { tools: ToolRegistry }) => {
          const tool = request.tools.get("autonomy_send_message");
          expect(tool).toBeDefined();
          out = await tool!.execute({ message: "আমি একটি গুরুত্বপূর্ণ আপডেট পেয়েছি।" }, {} as never);
          return makeResult("Sent the owner update.");
        });
        nowMs += 1_300_000;
        await (supervisor as any).runAmbientDecision("idle");
        expect(out).toMatchObject({ delivered: true, sent: true, delivery: { delivered: 1 } });
        expect(notes).toEqual(expect.arrayContaining([
          expect.objectContaining({ text: "আমি একটি গুরুত্বপূর্ণ আপডেট পেয়েছি।", kind: "result" }),
        ]));
      });

      it("can send multiple useful messages in one autonomous decision", async () => {
        const outcomes: unknown[] = [];
        run.mockImplementationOnce(async (request: { tools: ToolRegistry }) => {
          const tool = request.tools.get("autonomy_send_message");
          expect(tool).toBeDefined();
          outcomes.push(await tool!.execute({ message: "প্রথম দরকারি আপডেট।" }, {} as never));
          outcomes.push(await tool!.execute({ message: "আরেকটি গুরুত্বপূর্ণ তথ্য।" }, {} as never));
          return makeResult("Sent two useful updates.");
        });
        nowMs += 1_300_000;
        await (supervisor as any).runAmbientDecision("idle");
        expect(outcomes).toHaveLength(2);
        expect(outcomes).toEqual(expect.arrayContaining([
          expect.objectContaining({ delivered: true, sent: true }),
          expect.objectContaining({ delivered: true, sent: true }),
        ]));
        expect(notes).toEqual(expect.arrayContaining([
          expect.objectContaining({ text: "প্রথম দরকারি আপডেট।", kind: "result" }),
          expect.objectContaining({ text: "আরেকটি গুরুত্বপূর্ণ তথ্য।", kind: "result" }),
        ]));
      });

      it("announces an important finding as facts only, with kind discovery and its sources", async () => {
        const out = await share({ ...base, title: "New local model released", source_urls: ["https://example.org/a"] });
        expect(out).toMatchObject({ saved: true, notified: true });
        const [sent] = discoveryEvents();
        expect(sent).toMatchObject({ kind: "discovery", event: { type: "discovery_shared", title: "New local model released", importance: 4, source_urls: ["https://example.org/a"], why_interesting: "It changes what I can run locally." } });
        expect(sent.text).toBeUndefined(); // the gateway composes the wording in the user's language
        expect(db.prepare("SELECT notified_at IS NOT NULL AS n FROM autonomy_discoveries WHERE id=?").get(out.id)).toEqual({ n: 1 });
      });

      it("does not mark a discovery notified when every destination is still pending or unavailable", async () => {
        notify.mockResolvedValueOnce({
          delivered: 0,
          dashboard: { attempted: 0, delivered: 0, failed: 0 },
          channels: { attempted: 0, delivered: 0, queued: 0, failed: 0 },
          queued: 1,
          failures: ["No dashboard client or channel recipient is connected."],
        });
        const out = await share({ ...base, title: "Queued but not yet delivered" });
        expect(out).toMatchObject({ saved: true, notified: false, queued: true });
        expect(db.prepare("SELECT notified_at FROM autonomy_discoveries WHERE id=?").get(out.id)).toEqual({ notified_at: null });
      });

      it("saves quietly when importance is below share_min_importance", async () => {
        const out = await share({ ...base, title: "Minor changelog note", importance: 2 });
        expect(out).toMatchObject({ saved: true, notified: false });
        expect(discoveryEvents()).toHaveLength(0);
      });

      it("saves quietly when the model says the user would not want to know", async () => {
        const out = await share({ ...base, title: "Internal housekeeping result", importance: 5, user_would_want_to_know: false });
        expect(out).toMatchObject({ saved: true, notified: false });
        expect(discoveryEvents()).toHaveLength(0);
      });

      it("does not announce the same title twice within 7 days", async () => {
        await share({ ...base, title: "Same finding" });
        nowMs += 3_600_000; // past the minimum gap
        const second = await share({ ...base, title: "same   FINDING" });
        expect(second).toMatchObject({ saved: true, notified: false });
        expect(discoveryEvents()).toHaveLength(1);
      });

      it("holds a finding back inside the minimum gap and sends it when the gap has passed", async () => {
        await share({ ...base, title: "First finding" });
        const held = await share({ ...base, title: "Second finding" });
        expect(held).toMatchObject({ notified: false, queued: true });
        expect(discoveryEvents()).toHaveLength(1);

        nowMs += 31 * 60_000;
        await (supervisor as any).flushPendingDiscovery((supervisor as any).config());
        expect(discoveryEvents()).toHaveLength(2);
        expect(discoveryEvents()[1].event?.title).toBe("Second finding");
      });

      it("sends the most important held finding first", async () => {
        config = { ...config, heartbeat: { ...(config.heartbeat as object), proactive: { enabled: true, decision_interval_seconds: 15 } } };
        await share({ ...base, title: "Opening finding" }, 20_000);
        await share({ ...base, title: "Medium finding", importance: 3 }, 20_000);
        await share({ ...base, title: "Top finding", importance: 5 }, 20_000);
        nowMs += 31 * 60_000;
        await (supervisor as any).flushPendingDiscovery((supervisor as any).config());
        expect(discoveryEvents()[1].event?.title).toBe("Top finding");
      });

      it("stops at share_max_per_day and resumes after 24 hours", async () => {
        config = { ...config, heartbeat: { ...(config.heartbeat as object), proactive: { enabled: true, decision_interval_seconds: 900, share_max_per_day: 1, share_min_gap_minutes: 0 } } };
        await share({ ...base, title: "Finding one" });
        const second = await share({ ...base, title: "Finding two" });
        expect(second).toMatchObject({ notified: false, queued: true });
        nowMs += 25 * 3_600_000;
        await (supervisor as any).flushPendingDiscovery((supervisor as any).config());
        expect(discoveryEvents().map((n) => n.event?.title)).toEqual(["Finding one", "Finding two"]);
      });
    });

    it("classifies provider failures", () => {
      expect(classifyFailure("No model is configured for this run.")).toBe("no_provider");
      expect(classifyFailure("Model provider returned HTTP 429")).toBe("rate_limit");
      expect(classifyFailure("Incorrect API key provided")).toBe("auth");
      expect(classifyFailure(new Error("fetch failed: ECONNRESET"))).toBe("network");
      expect(classifyFailure("HTTP 503 service unavailable")).toBe("provider_error");
      expect(classifyFailure(Object.assign(new Error("boom"), { status: 429 }))).toBe("rate_limit");
      expect(classifyFailure("Run exceeded the maximum number of turns.")).toBe("other");
    });

    it("treats a failed model run as a failure with short backoff, not as completed work", async () => {
      run.mockResolvedValue(failed("Model provider returned HTTP 429"));
      await decide("startup");
      const loop = supervisor.status().proactive_loop;
      expect(loop.failure_streak).toBe(1);
      expect(loop.last_failure).toMatchObject({ kind: "rate_limit" });
      expect(loop.next_decision_in_seconds).toBeLessThanOrEqual(2); // 2s minimum backoff, not hours

      nowMs += 1_000;
      await decide("idle");
      expect(run).toHaveBeenCalledTimes(1); // still backing off

      nowMs += 2_000;
      await decide("idle");
      expect(run).toHaveBeenCalledTimes(2);
      expect(supervisor.status().proactive_loop.failure_streak).toBe(2);
    });

    it("opens the circuit with a single warning, then recovers and says so", async () => {
      run.mockResolvedValue(failed("No model is configured"));
      await decide("startup");
      for (let i = 0; i < 4; i += 1) { nowMs += 130_000; await decide("idle"); }
      expect(notes.filter((n) => n.kind === "warning")).toHaveLength(1);
      expect(supervisor.status().proactive_loop.circuit_open).toBe(true);

      run.mockResolvedValue(makeResult("Worked on a research topic."));
      nowMs += 130_000;
      await decide("idle");
      expect(supervisor.status().proactive_loop).toMatchObject({ failure_streak: 0, circuit_open: false });
      expect(notes.filter((n) => n.kind === "progress")).toHaveLength(1);
    });

    it("counts a thrown provider error as a failure too", async () => {
      run.mockRejectedValue(new Error("fetch failed ECONNREFUSED"));
      await decide("startup");
      expect(supervisor.status().proactive_loop).toMatchObject({ failure_streak: 1, last_failure: expect.objectContaining({ kind: "network" }) });
    });

    it("does not count a shutdown cancellation as a failure", async () => {
      run.mockResolvedValue({ ...makeResult("", "failed"), status: "cancelled", error: "Run cancelled." });
      await decide("startup");
      expect(supervisor.status().proactive_loop.failure_streak).toBe(0);
    });

    it("keeps a proactive decision successful when notification delivery throws", async () => {
      notify.mockRejectedValue(new Error("socket closed"));
      run.mockImplementationOnce(async (request: { tools: ToolRegistry }) => {
        await request.tools.get("autonomy_propose_goal")!.execute({
          title: "Look into something useful", description: "d",
          acceptance: { checks: [{ type: "tool_called", name: "file_write", status: "succeeded" }] },
        }, {} as never);
        return makeResult("Queued a goal.");
      });
      await expect(decide("startup")).resolves.toBe(true);
      expect(logs.some((line) => line.includes("notification failed"))).toBe(true);
      expect(supervisor.status().proactive_loop.failure_streak).toBe(0);
    });

    it("does not mark a completed goal as failed when notification delivery throws", async () => {
      notify.mockRejectedValue(new Error("db locked"));
      const goal = goals.create({ title: "Notify fails", steps: ["Inspect"], replaceExisting: false });
      const result = await supervisor.tick("test");
      expect(result.status).toBe("completed");
      expect(goals.get(goal.id)?.status).toBe("completed");
    });

    it("blocks a goal when no model provider is configured instead of retrying a permanent setup error", async () => {
      run.mockResolvedValue(failed("No model is configured"));
      const goal = goals.create({ title: "Provider configuration", steps: ["Inspect"], replaceExisting: false });
      const result = await supervisor.tick("test");
      expect(result.status).toBe("blocked");
      expect(goals.get(goal.id)?.status).toBe("blocked");
      expect(run).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT status,next_retry_at FROM autonomy_goal_runs WHERE goal_id=?").get(goal.id)).toEqual({ status: "blocked", next_retry_at: null });
    });

    it("keeps retrying logic failures beyond the legacy max_retries setting", async () => {
      config = { autonomy: { enabled: true, tool_policy: { max_retries: 2, retry_backoff_seconds: 5, require_acceptance_contract: false } }, heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 } } };
      run.mockResolvedValue(failed("Run exceeded the maximum number of turns."));
      const goal = goals.create({ title: "Genuinely failing", steps: ["Inspect"], replaceExisting: false });
      for (let i = 0; i < 6; i += 1) {
        nowMs += 1_000; // run ids are time-based
        await supervisor.tick("test");
        db.prepare("UPDATE autonomy_goal_runs SET next_retry_at=? WHERE goal_id=?").run("2000-01-01T00:00:00.000Z", goal.id);
      }
      expect(goals.get(goal.id)?.status).toBe("pending");
      expect(run.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect((db.prepare("SELECT next_retry_at FROM autonomy_goal_runs WHERE goal_id=? ORDER BY started_at DESC LIMIT 1").get(goal.id) as { next_retry_at: string | null }).next_retry_at).toBeTruthy();
    });

    describe("repeated failures and rejected API keys", () => {
      const eventsOf = (type: string) => notes.filter((n) => (n as { event?: { type?: string } }).event?.type === type);
      const tickMany = async (count: number, goalId: number) => {
        for (let i = 0; i < count; i += 1) {
          nowMs += 1_000;
          await supervisor.tick("test");
          db.prepare("UPDATE autonomy_goal_runs SET next_retry_at=? WHERE goal_id=?").run("2000-01-01T00:00:00.000Z", goalId);
        }
      };

      it("recognises near-identical failure texts and ignores volatile numbers and ids", () => {
        expect(similarFailure("Required file /data/report-17.csv does not exist", "Required file /data/report-903.csv does not exist")).toBe(true);
        expect(similarFailure("BLOCKED: the vendor portal needs a login", "BLOCKED: vendor portal needs login")).toBe(true);
        expect(similarFailure("Required file does not exist", "The tool returned an unexpected schema for the invoice list")).toBe(false);
      });

      it("forces a different strategy and tells the user once when the same failure keeps happening, within the configured retry budget", async () => {
        config = { ...config, autonomy: { enabled: true, tool_policy: { max_retries: 10, retry_backoff_seconds: 5, require_acceptance_contract: false } } };
        const goal = goals.create({ title: "Impossible goal", steps: ["Try"], replaceExisting: false });
        let n = 0;
        run.mockImplementation(async () => failed(`Required file /data/report-${(n += 7)}.csv does not exist`));
        await tickMany(6, goal.id);

        expect(run).toHaveBeenCalledTimes(6);
        expect(goals.get(goal.id)?.status).toBe("pending"); // still no hard cap
        expect(eventsOf("goal_repeating_failure")).toHaveLength(1);
        expect(eventsOf("goal_repeating_failure")[0]).toMatchObject({ kind: "warning", goalId: goal.id });
        // The 1st retry is an ordinary re-plan; from the 2nd identical failure on, a different strategy is mandatory.
        expect(String(run.mock.calls[1][0].goal)).not.toContain("REPEATED FAILURE");
        expect(String(run.mock.calls[2][0].goal)).toContain("MANDATORY - REPEATED FAILURE");
        expect(String(run.mock.calls[5][0].goal)).toContain("fundamentally different strategy");
      });

      it("does not report a goal whose failures keep changing", async () => {
        config = { ...config, autonomy: { enabled: true, tool_policy: { max_retries: 10, retry_backoff_seconds: 5, require_acceptance_contract: false } } };
        const goal = goals.create({ title: "Making progress", steps: ["Try"], replaceExisting: false });
        const texts = ["Cannot parse the invoice header", "The upload endpoint rejected the multipart body", "Disk quota exceeded while writing the archive", "Unknown column named customer_region in the export", "Certificate chain is incomplete for the partner host"];
        let i = 0;
        run.mockImplementation(async () => failed(texts[i++ % texts.length]));
        await tickMany(5, goal.id);
        expect(eventsOf("goal_repeating_failure")).toHaveLength(0);
        expect(String(run.mock.calls[4][0].goal)).not.toContain("REPEATED FAILURE");
      });

      it("never counts an outage as a repeated goal failure", async () => {
        const goal = goals.create({ title: "Flaky network", steps: ["Try"], replaceExisting: false });
        run.mockResolvedValue(failed("fetch failed: ECONNRESET"));
        await tickMany(6, goal.id);
        expect(eventsOf("goal_repeating_failure")).toHaveLength(0);
      });

      it("an outage between identical failures does not reset their streak", async () => {
        config = { ...config, autonomy: { enabled: true, tool_policy: { max_retries: 10, retry_backoff_seconds: 5, require_acceptance_contract: false } } };
        const goal = goals.create({ title: "Impossible with blips", steps: ["Try"], replaceExisting: false });
        const sequence = ["Required file missing.csv does not exist", "fetch failed: ECONNRESET", "Required file missing.csv does not exist", "fetch failed: ECONNRESET", "Required file missing.csv does not exist"];
        let i = 0;
        run.mockImplementation(async () => failed(sequence[i++]));
        await tickMany(5, goal.id);
        expect(eventsOf("goal_repeating_failure")).toHaveLength(1);
      });

      it("notifies once and blocks a goal when the API key is rejected until the owner fixes it", async () => {
        const goal = goals.create({ title: "Wrong key", steps: ["Try"], replaceExisting: false });
        run.mockResolvedValue(failed("Model provider returned HTTP 401: Incorrect API key provided"));
        nowMs += 1_000;
        const result = await supervisor.tick("test");
        expect(result.status).toBe("blocked");
        expect(eventsOf("provider_auth_failed")).toHaveLength(1);
        expect(eventsOf("provider_auth_failed")[0]).toMatchObject({ kind: "warning" });
        expect(goals.get(goal.id)?.status).toBe("blocked");
        expect(db.prepare("SELECT status,next_retry_at FROM autonomy_goal_runs WHERE goal_id=?").get(goal.id)).toEqual({ status: "blocked", next_retry_at: null });
        expect(db.prepare("SELECT COUNT(*) AS c FROM autonomy_notice_state").get()).toEqual({ c: 1 });

        // A restarted supervisor keeps the prior notice; blocked goals do not replay themselves.
        supervisor = build();
        nowMs += 1_000;
        await supervisor.tick("test");
        expect(eventsOf("provider_auth_failed")).toHaveLength(1);
        expect(run).toHaveBeenCalledTimes(1);

        // After the key is corrected, the owner reactivates the goal and it completes.
        run.mockResolvedValue(makeResult("Inspection complete."));
        goals.update(goal.id, { status: "active", statusReason: "Owner corrected provider credentials." });
        nowMs += 1_000;
        expect((await supervisor.tick("test")).status).toBe("completed");
        expect(db.prepare("SELECT COUNT(*) AS c FROM autonomy_notice_state").get()).toEqual({ c: 0 });
        const second = goals.create({ title: "Wrong key again", steps: ["Try"], replaceExisting: false });
        run.mockResolvedValue(failed("Incorrect API key provided"));
        nowMs += 1_000;
        await supervisor.tick("test");
        expect(eventsOf("provider_auth_failed")).toHaveLength(2);
      });
    });

    it("treats a model timeout as an environment problem and never blocks the goal", async () => {
      expect(classifyFailure("The model provider timed out.")).toBe("timeout");
      run.mockResolvedValue(failed("The model provider timed out."));
      const goal = goals.create({ title: "Offline network", steps: ["Inspect"], replaceExisting: false });
      for (let i = 0; i < 8; i += 1) {
        nowMs += 1_000;
        await supervisor.tick("test");
        db.prepare("UPDATE autonomy_goal_runs SET next_retry_at=? WHERE goal_id=?").run("2000-01-01T00:00:00.000Z", goal.id);
      }
      expect(goals.get(goal.id)?.status).not.toBe("blocked");
      expect(run.mock.calls.length).toBe(8);
      run.mockResolvedValue(makeResult("Inspection complete."));
      nowMs += 1_000;
      expect((await supervisor.tick("test")).status).toBe("completed");
    });

    it("never schedules a retry more than 12 seconds ahead, for outages or for logic failures", async () => {
      config = { ...config, autonomy: { enabled: true, tool_policy: { retry_backoff_seconds: 60, max_retries: 10, require_acceptance_contract: false } }, heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 }, proactive: { enabled: true, decision_interval_seconds: 900, failure_threshold: 3, model_retry_seconds: 2, failure_backoff_base_seconds: 2, failure_backoff_max_seconds: 12 } } };
      supervisor = build();
      for (const message of ["fetch failed: ECONNRESET", "Run exceeded the maximum number of turns."]) {
        const goal = goals.create({ title: `Capped ${message}`, steps: ["Inspect"], replaceExisting: false });
        run.mockResolvedValue(failed(message));
        for (let i = 0; i < 10; i += 1) {
          nowMs += 1_000;
          await supervisor.tick("test");
          const row = db.prepare("SELECT next_retry_at FROM autonomy_goal_runs WHERE goal_id=? ORDER BY started_at DESC LIMIT 1").get(goal.id) as { next_retry_at: string | null };
          expect(row.next_retry_at).toBeTruthy();
          expect(Date.parse(row.next_retry_at as string) - nowMs).toBeLessThanOrEqual(12_000);
          db.prepare("UPDATE autonomy_goal_runs SET next_retry_at=? WHERE goal_id=?").run("2000-01-01T00:00:00.000Z", goal.id);
        }
        goals.update(goal.id, { status: "completed", statusReason: "test cleanup" });
      }
    });

    it("uses one short in-run retry before bounded exponential failed-run backoff", () => {
      config = { ...config, heartbeat: { enabled: true, auto_actions: { enabled: true, max_actions_per_cycle: 1 }, proactive: { enabled: true, decision_interval_seconds: 900, model_retry_seconds: 2, model_retry_max_retries: 1, failure_backoff_base_seconds: 30, failure_backoff_max_seconds: 60 } } };
      const retryOptions = (supervisor as any).modelRetryOptions((supervisor as any).config());
      expect(retryOptions).toMatchObject({
        baseDelayMs: 2_000,
        maxDelayMs: 2_000,
        maxRetries: 1,
        jitter: false,
      });
      expect((supervisor as any).logicRetrySeconds((supervisor as any).config(), 1)).toBe(30);
      expect((supervisor as any).logicRetrySeconds((supervisor as any).config(), 2)).toBe(60);
    });
  });
});
