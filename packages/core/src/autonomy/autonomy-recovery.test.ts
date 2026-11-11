import { TaskExecutionError } from "../tasks/task-errors.js";
import Database from "better-sqlite3";
import { GoalStore } from "../api/goals-router.js";
import { ToolRegistry } from "../engine/tool-registry.js";
import { AutonomousSupervisor, classifyFailure } from "./autonomous-supervisor.js";
import { verifyGoalAcceptance } from "./goal-acceptance.js";
import { toolEffectConfirmation } from "../engine/tool-effect.js";

/**
 * Provider recovery and verified completion, with a fake clock and a fake engine only.
 * Nothing here talks to a real provider, sends a real message, buys or publishes anything.
 */

type FakeResult = {
  runId: string; status: "completed" | "failed" | "cancelled" | "limit_reached"; model: string; goal: string; finalText: string;
  error?: string; failureKind?: "auth" | "entitlement" | "transient" | "no_model"; turns: number; toolCalls: unknown[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }; startedAt: string; finishedAt: string;
};

const ok = (finalText = "Done."): FakeResult => ({
  runId: "r", status: "completed", model: "m", goal: "g", finalText, turns: 1, toolCalls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
});
const failedWith = (error: string, failureKind?: FakeResult["failureKind"], turns = 0): FakeResult =>
  ({ ...ok(""), status: "failed", error, ...(failureKind ? { failureKind } : {}), turns });

function tools() {
  const registry = new ToolRegistry();
  for (const name of ["workspace_list", "file_read", "memory_search", "goal_status", "file_write", "file_mkdir", "file_info", "workspace_search", "memory_add", "channel_send"]) {
    registry.register({ name, description: name, risk: "read", parameters: { type: "object", properties: {} }, approval: "auto", execute: async () => ({ ok: true }) });
  }
  return registry;
}

describe("provider recovery and verified completion", () => {
  let db: Database.Database;
  let goals: GoalStore;
  let run: jest.Mock;
  let nowMs: number;
  let spy: jest.SpyInstance;
  let notes: Array<{ event?: Record<string, unknown>; kind?: string }>;
  let supervisor: AutonomousSupervisor;
  let config: Record<string, unknown>;

  const build = () => new AutonomousSupervisor({
    db, agent: { run }, tools: tools(), activeRunCount: () => 0, getConfig: () => config,
    log: () => undefined, now: () => new Date(nowMs).toISOString(), notify: (n) => { notes.push(n); },
  });
  const decide = (trigger: "startup" | "idle" = "idle") => (supervisor as any).runAmbientDecision(trigger) as Promise<boolean>;
  const events = (type: string) => notes.filter((n) => n.event?.type === type);
  const health = () => supervisor.status().provider_health as ReturnType<AutonomousSupervisor["providerHealth"]>;
  const contractGoal = (title: string, checks: unknown[]) =>
    goals.create({ title, steps: ["Do it"], acceptance: { mode: "all", checks } as never, replaceExisting: false });

  beforeEach(() => {
    db = new Database(":memory:");
    goals = new GoalStore(db);
    db.exec(`
      CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE memory_chunks (id TEXT PRIMARY KEY, region TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO memory_chunks(id,region,content,summary,created_at,updated_at) VALUES('s','long_term','s','s','2026-01-01','2026-01-01')").run();
    nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    spy = jest.spyOn(Date, "now").mockImplementation(() => nowMs);
    run = jest.fn();
    notes = [];
    config = {
      autonomy: { enabled: true }, // acceptance contract required (default, fail-closed)
      heartbeat: { enabled: true, proactive: { enabled: true, decision_interval_seconds: 900, failure_threshold: 3, failure_backoff_base_seconds: 2, failure_backoff_max_seconds: 60 } },
    };
    supervisor = build();
    (supervisor as any).running = true; // the loop itself is not started here; ticks and decisions are driven directly
  });
  afterEach(() => { (supervisor as any).running = false; spy.mockRestore(); db.close(); });

  describe("provider recovery", () => {
    it("retries after a bounded backoff once the provider is back, then clears every failure indicator", async () => {
      run.mockResolvedValue(failedWith("provider unreachable", "transient"));
      await decide("startup");
      expect(health()).toMatchObject({ state: "backing_off", failure_streak: 1, last_failure: expect.objectContaining({ kind: "transient" }) });

      // Still inside the backoff window: no new attempt (no tight retry loop).
      nowMs += 1_000;
      await decide();
      expect(run).toHaveBeenCalledTimes(1);

      // Backoff elapsed while the provider is still down: a fresh attempt is made and the wait grows, capped.
      nowMs += 2_000;
      await decide();
      expect(run).toHaveBeenCalledTimes(2);
      for (let i = 0; i < 10; i += 1) { nowMs += 61_000; await decide(); }
      expect((supervisor.status().proactive_loop as { next_decision_in_seconds: number }).next_decision_in_seconds).toBeLessThanOrEqual(60);
      expect(health().circuit_open).toBe(true);

      // The provider is back: the next due attempt really runs and everything is cleared.
      const callsBefore = run.mock.calls.length;
      run.mockResolvedValue(ok("Worked on something useful."));
      nowMs += 61_000;
      await decide();
      expect(run.mock.calls.length).toBe(callsBefore + 1);
      expect(health()).toMatchObject({ state: "healthy", failure_streak: 0, circuit_open: false, last_failure: null });
      expect(health().last_recovered_at).toBe(new Date(nowMs).toISOString());
      expect(events("background_autonomy_recovered")).toHaveLength(1);
    });

    it("classifies from structured signals first, so the wording of an error cannot misroute it", () => {
      expect(classifyFailure({ failureKind: "no_model" })).toBe("no_provider");
      expect(classifyFailure({ failureKind: "entitlement" })).toBe("auth");
      expect(classifyFailure({ failureKind: "transient" })).toBe("transient");
      expect(classifyFailure(Object.assign(new Error("opaque"), { status: 401 }))).toBe("auth");
      expect(classifyFailure(Object.assign(new Error("opaque"), { status: 503 }))).toBe("provider_error");
      expect(classifyFailure(Object.assign(new Error("opaque"), { name: "NoModelConfiguredError" }))).toBe("no_provider");
      // Free-form text is never guessed into a provider fault, even when it contains familiar wording.
      expect(classifyFailure("something unrelated broke")).toBe("other");
      expect(classifyFailure("401 invalid api key; try again")).toBe("other");
      expect(classifyFailure(Object.assign(new Error("opaque"), { code: "ECONNRESET" }))).toBe("network");
      expect(classifyFailure(new TaskExecutionError("opaque", { category: "uncertain_side_effect" }))).toBe("owner_action");
      expect(classifyFailure(new TaskExecutionError("opaque", { category: "permanent_validation" }))).toBe("owner_action");
    });

    it("treats a circuit-open error as a transient outage even though its text names no known cause", async () => {
      const circuitOpen = Object.assign(new Error("circuit open, try later"), { status: 503, code: "MODEL_CIRCUIT_OPEN" });
      run.mockRejectedValue(circuitOpen);
      await decide("startup");
      expect(health().last_failure).toMatchObject({ kind: "provider_error" });
      expect(health().state).toBe("backing_off");
    });

    it("keeps auth/configuration failures apart from outages: owner-action state, one notice, bounded retries", async () => {
      run.mockResolvedValue(failedWith("rejected", "auth"));
      await decide("startup");
      expect(health()).toMatchObject({ state: "needs_owner_action", last_failure: expect.objectContaining({ kind: "auth" }) });
      expect(events("provider_auth_failed")).toHaveLength(1);

      for (let i = 0; i < 5; i += 1) { nowMs += 61_000; await decide(); }
      expect(events("provider_auth_failed")).toHaveLength(1); // told once
      expect(run).toHaveBeenCalledTimes(6); // one attempt per backoff window, never a tight loop

      run.mockResolvedValue(failedWith("transient hiccup", "transient"));
      nowMs += 61_000;
      await decide();
      expect(health().state).toBe("backing_off"); // an outage is not an owner-action state

      run.mockResolvedValue(ok("Fine again."));
      nowMs += 61_000;
      await decide();
      expect(health()).toMatchObject({ state: "healthy", failure_streak: 0 });
    });

    it("shows 'retrying' while a run waits inside the engine, and 'healthy' once the call resumes", async () => {
      let observed: ReturnType<AutonomousSupervisor["providerHealth"]> | undefined;
      run.mockImplementation(async (request: { onEvent?: (event: unknown) => void }) => {
        request.onEvent?.({ type: "model.retrying", runId: "x", turn: 1, retry: 2, delayMs: 5_000, reason: "provider unreachable", failureKind: "transient" });
        observed = health();
        request.onEvent?.({ type: "model.resumed", runId: "x", turn: 1, retries: 2 });
        return ok("Resumed and finished.");
      });
      await decide("startup");
      expect(observed).toMatchObject({ state: "retrying", retrying_runs: [expect.objectContaining({ retry: 2, kind: "transient" })] });
      expect(observed?.next_attempt_at).toBe(new Date(nowMs + 5_000).toISOString());
      expect(health()).toMatchObject({ state: "healthy", retrying_runs: [] });
    });

    it("does not count a run that failed for its own reasons as a provider failure, and a model that answered clears an old failure", async () => {
      run.mockResolvedValue(failedWith("provider unreachable", "transient"));
      await decide("startup");
      expect(health().failure_streak).toBe(1);

      // The model answered (turns > 0) and the run then failed on something unrelated to the provider.
      run.mockResolvedValue(failedWith("a tool exploded", undefined, 3));
      nowMs += 3_000;
      await decide();
      expect(health()).toMatchObject({ state: "healthy", failure_streak: 0, last_failure: null });
    });

    it("keeps backing off, truthfully, when an unclassified failure never reached the model", async () => {
      run.mockResolvedValue(failedWith("unexplained", undefined, 0));
      await decide("startup");
      expect(health()).toMatchObject({ state: "backing_off", failure_streak: 1, last_failure: expect.objectContaining({ kind: "other" }) });
    });

    it("reports paused and stopped from the real runtime state", () => {
      expect(health().state).toBe("healthy");
      (supervisor as any).running = false;
      expect(health().state).toBe("stopped");
      (supervisor as any).running = true;
      supervisor.pause();
      expect(health().state).toBe("paused");
      supervisor.resume();
      expect(health().state).toBe("healthy");
      (supervisor as any).running = false;
    });
  });

  describe("goals during provider outages", () => {
    it("retries a goal that failed on a transient outage and never blocks it", async () => {
      run.mockResolvedValue(failedWith("provider unreachable", "transient"));
      const goal = contractGoal("Outage goal", [{ type: "tool_called", name: "file_write", status: "succeeded" }]);
      nowMs += 1_000;
      await supervisor.tick("test");
      expect(goals.get(goal.id)?.status).toBe("pending");
      expect(db.prepare("SELECT status FROM autonomy_goal_runs WHERE goal_id=?").get(goal.id)).toEqual({ status: "retry_wait" });
      expect(db.prepare("SELECT infra FROM autonomy_goal_replans WHERE goal_id=?").get(goal.id)).toEqual({ infra: 1 });
    });

    it("parks a goal on an auth failure, and resumes it by itself once the provider answers again", async () => {
      run.mockResolvedValue(failedWith("rejected", "auth"));
      const goal = contractGoal("Needs a key", [{ type: "tool_called", name: "file_write", status: "succeeded" }]);
      nowMs += 1_000;
      expect((await supervisor.tick("test")).status).toBe("blocked");
      expect(goals.get(goal.id)?.status).toBe("blocked");
      expect(run).toHaveBeenCalledTimes(1);

      // Parked: further ticks do not hammer the provider.
      nowMs += 1_000;
      await supervisor.tick("test");
      expect(run).toHaveBeenCalledTimes(1);

      // The key is fixed; a background decision succeeds, which releases the parked goal.
      run.mockResolvedValue(ok("Background decision fine."));
      nowMs += 61_000;
      await decide();
      expect(goals.get(goal.id)?.status).toBe("pending");
      expect(events("goal_resumed_after_provider_recovery")).toHaveLength(1);

      // And the goal really executes again and completes only with verified evidence.
      run.mockImplementation(async (request: { onEvent?: (event: unknown) => void }) => {
        request.onEvent?.({ type: "tool.call", runId: "r", turn: 1, call: { id: "c1", name: "file_write", status: "succeeded", effectConfirmed: true } });
        return ok("Wrote the file.");
      });
      nowMs += 1_000;
      expect((await supervisor.tick("test")).status).toBe("completed");
      expect(goals.get(goal.id)?.status).toBe("completed");
    });

    it("never resumes a goal that was blocked for a reason other than the provider", async () => {
      config = { ...config, autonomy: { enabled: true } };
      const goal = goals.create({ title: "No contract", steps: ["x"], replaceExisting: false });
      nowMs += 1_000;
      expect((await supervisor.tick("test")).status).toBe("blocked");
      run.mockResolvedValue(ok("Fine."));
      nowMs += 61_000;
      await decide();
      expect(goals.get(goal.id)?.status).toBe("blocked");
      expect(events("goal_resumed_after_provider_recovery")).toHaveLength(0);
    });

    it("clears a stale provider failure when a goal run proves the model answers, even if the goal itself failed", async () => {
      run.mockResolvedValue(failedWith("provider unreachable", "transient"));
      await decide("startup");
      expect(health().failure_streak).toBe(1);
      run.mockResolvedValue({ ...ok("I could not finish."), turns: 2 });
      contractGoal("Fails its acceptance", [{ type: "tool_called", name: "file_write", status: "succeeded" }]);
      nowMs += 3_000;
      await supervisor.tick("test");
      expect(health()).toMatchObject({ failure_streak: 0, last_failure: null });
    });
  });

  describe("completion is only declared on verified evidence", () => {
    const toolCall = (request: { onEvent?: (event: unknown) => void }, call: Record<string, unknown>) =>
      request.onEvent?.({ type: "tool.call", runId: "r", turn: 1, call: { id: "c1", name: "channel_send", ...call } });
    const sendContract = [{ type: "tool_called", name: "channel_send", status: "succeeded", requireConfirmation: true }];

    it("does not complete when a tool failed, however confidently the model reports success", async () => {
      const goal = contractGoal("Write the report", [{ type: "tool_called", name: "file_write", status: "succeeded" }]);
      run.mockImplementation(async (request: { onEvent?: (event: unknown) => void }) => {
        request.onEvent?.({ type: "tool.call", runId: "r", turn: 1, call: { id: "c1", name: "file_write", status: "failed", error: "disk full" } });
        return ok("All done, the report was written successfully!");
      });
      nowMs += 1_000;
      const result = await supervisor.tick("test");
      expect(result.status).toBe("idle");
      expect(goals.get(goal.id)?.status).toBe("pending");
      const row = db.prepare("SELECT status,acceptance_result FROM autonomy_goal_runs WHERE goal_id=?").get(goal.id) as { status: string; acceptance_result: string };
      expect(row.status).toBe("retry_wait");
      expect(JSON.parse(row.acceptance_result).passed).toBe(false);
      expect(events("goal_completed")).toHaveLength(0);
    });

    it("does not complete when the acceptance check cannot pass (job output missing)", async () => {
      const goal = contractGoal("Make the file", [{ type: "file_exists", path: "autonomy/never-created.txt" }]);
      run.mockResolvedValue(ok("The file has been created."));
      nowMs += 1_000;
      expect((await supervisor.tick("test")).status).toBe("idle");
      expect(goals.get(goal.id)?.status).toBe("pending");
      expect(events("goal_completed")).toHaveLength(0);
    });

    it("completes once the acceptance check passes, and the notice carries the verified evidence", async () => {
      const goal = contractGoal("Write the report", [{ type: "tool_called", name: "file_write", status: "succeeded" }]);
      run.mockImplementation(async (request: { onEvent?: (event: unknown) => void }) => {
        request.onEvent?.({ type: "tool.call", runId: "r", turn: 1, call: { id: "c1", name: "file_write", status: "succeeded" } });
        return ok("Report written.");
      });
      nowMs += 1_000;
      expect((await supervisor.tick("test")).status).toBe("completed");
      expect(goals.get(goal.id)?.status).toBe("completed");
      const [completed] = events("goal_completed");
      expect(completed.event).toMatchObject({ verified: true, verification: { passed: true, checks: [expect.objectContaining({ type: "tool_called", passed: true })] } });
    });

    it("regression: a send tool that finished but did not deliver is never reported as completed", async () => {
      const goal = contractGoal("Send the summary", sendContract);
      run.mockImplementation(async (request: { onEvent?: (event: unknown) => void }) => {
        toolCall(request, { status: "succeeded", effectConfirmed: false }); // the tool's own result said delivered:false
        return ok("I sent the summary to the user.");
      });
      nowMs += 1_000;
      expect((await supervisor.tick("test")).status).toBe("idle");
      expect(goals.get(goal.id)?.status).toBe("pending");
      const row = db.prepare("SELECT acceptance_result FROM autonomy_goal_runs WHERE goal_id=?").get(goal.id) as { acceptance_result: string };
      expect(JSON.parse(row.acceptance_result).checks[0].detail).toMatch(/effect did not happen/);
      expect(events("goal_completed")).toHaveLength(0);
    });

    it("regression: a send tool whose result says nothing about delivery cannot satisfy a confirmation-required check", async () => {
      const goal = contractGoal("Send the summary", sendContract);
      run.mockImplementation(async (request: { onEvent?: (event: unknown) => void }) => {
        toolCall(request, { status: "succeeded" }); // no delivery flag in the result
        return ok("Sent.");
      });
      nowMs += 1_000;
      await supervisor.tick("test");
      expect(goals.get(goal.id)?.status).toBe("pending");
      expect(events("goal_completed")).toHaveLength(0);
    });

    it("completes a confirmation-required goal only when the tool confirmed delivery", async () => {
      const goal = contractGoal("Send the summary", sendContract);
      run.mockImplementation(async (request: { onEvent?: (event: unknown) => void }) => {
        toolCall(request, { status: "succeeded", effectConfirmed: true });
        return ok("Sent.");
      });
      nowMs += 1_000;
      expect((await supervisor.tick("test")).status).toBe("completed");
      expect(goals.get(goal.id)?.status).toBe("completed");
    });

    it("says plainly that a legacy-mode completion was NOT independently verified", async () => {
      config = { ...config, autonomy: { enabled: true, tool_policy: { require_acceptance_contract: false } } };
      supervisor = build();
      const goal = goals.create({ title: "Legacy goal", steps: ["x"], replaceExisting: false });
      run.mockResolvedValue(ok("Finished."));
      nowMs += 1_000;
      expect((await supervisor.tick("test")).status).toBe("completed");
      expect(goals.get(goal.id)?.status_reason).toMatch(/WITHOUT independent verification/);
      expect(events("goal_completed")[0].event).toMatchObject({ verified: false });
    });
  });

  describe("acceptance verifier and tool-effect reading (pure)", () => {
    it("reads only explicit boolean effect fields from a structured result", () => {
      expect(toolEffectConfirmation({ delivered: true, files: [] })).toBe(true);
      expect(toolEffectConfirmation({ delivered: false })).toBe(false);
      expect(toolEffectConfirmation('{"ok":true,"delivered":false}')).toBe(false);
      expect(toolEffectConfirmation({ result: "message was sent" })).toBeUndefined(); // prose is never interpreted
      expect(toolEffectConfirmation("sent!")).toBeUndefined();
      expect(toolEffectConfirmation(null)).toBeUndefined();
    });

    it("verifies tool_called against the tool's own confirmation", async () => {
      const contract = (requireConfirmation?: boolean) => ({ mode: "all" as const, checks: [{ type: "tool_called" as const, name: "channel_send", status: "succeeded", ...(requireConfirmation === undefined ? {} : { requireConfirmation }) }] });
      const run1 = (calls: Array<{ name: string; status?: string; confirmed?: boolean }>, requireConfirmation?: boolean) =>
        verifyGoalAcceptance(contract(requireConfirmation), { finalText: "", toolCalls: calls });
      expect((await run1([{ name: "channel_send", status: "succeeded", confirmed: false }])).passed).toBe(false);
      expect((await run1([{ name: "channel_send", status: "succeeded" }])).passed).toBe(true); // unknown is accepted unless confirmation is required
      expect((await run1([{ name: "channel_send", status: "succeeded" }], true)).passed).toBe(false);
      expect((await run1([{ name: "channel_send", status: "succeeded", confirmed: true }], true)).passed).toBe(true);
      expect((await run1([{ name: "channel_send", status: "failed", confirmed: true }], true)).passed).toBe(false);
    });
  });
});
