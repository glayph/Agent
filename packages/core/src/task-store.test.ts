import Database from "better-sqlite3";
import { DurableTaskStore } from "./task-store.js";

describe("DurableTaskStore", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("persists a queued task and its creation event", () => {
    const store = new DurableTaskStore(db, () => "2026-10-15T00:00:00.000Z");
    const created = store.create({ taskId: "task-1", goal: "inspect workspace", sessionId: "session-1" });

    expect(created).toMatchObject({
      taskId: "task-1",
      goal: "inspect workspace",
      sessionId: "session-1",
      status: "queued",
      version: 0,
      createdAt: "2026-10-15T00:00:00.000Z",
      attemptCount: 0,
      maxAttempts: -1,
    });
    expect(store.listEvents("task-1")).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: "queued", version: 0, reason: "task created" }),
    ]);
  });

  it("records transactional transitions with monotonic versions", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "task-2", goal: "run checks", now: "2026-10-15T00:00:00.000Z" });

    const running = store.transition("task-2", "running", {
      now: "2026-10-15T00:00:01.000Z",
      leaseMs: 1_000,
      reason: "worker claimed task",
    });
    const verifying = store.transition("task-2", "verifying", {
      now: "2026-10-15T00:00:02.000Z",
      reason: "execution finished",
    });
    const completed = store.transition("task-2", "completed", {
      now: "2026-10-15T00:00:03.000Z",
      reason: "verification passed",
    });

    expect(running).toMatchObject({ status: "running", version: 1, leaseExpiresAt: "2026-10-15T00:00:02.000Z" });
    expect(verifying).toMatchObject({ status: "verifying", version: 2 });
    expect(completed).toMatchObject({ status: "completed", version: 3 });
    expect(store.listEvents("task-2").map((event) => [event.fromStatus, event.toStatus, event.version])).toEqual([
      [null, "queued", 0],
      ["queued", "running", 1],
      ["running", "verifying", 2],
      ["verifying", "completed", 3],
    ]);
  });

  it("reloads persisted tasks and requeues an expired worker lease", () => {
    const first = new DurableTaskStore(db);
    first.create({ taskId: "task-3", goal: "recover me", now: "2026-10-15T00:00:00.000Z" });
    first.claimNext("2026-10-15T00:00:01.000Z", 1_000);

    const restarted = new DurableTaskStore(db);
    expect(restarted.get("task-3")).toMatchObject({ status: "running", version: 1 });
    expect(restarted.recoverExpired("2026-10-15T00:00:03.000Z")).toMatchObject([
      { taskId: "task-3", status: "retrying", version: 2 },
    ]);
    expect(restarted.listEvents("task-3").at(-1)).toMatchObject({
      fromStatus: "running",
      toStatus: "retrying",
      reason: "worker lease expired; task requeued",
    });
    expect(restarted.claimNext("2026-10-15T00:00:04.000Z", 5_000)).toMatchObject({
      status: "running",
      version: 3,
    });
  });

  it("prunes only old or excess terminal jobs and preserves active work", () => {
    const store = new DurableTaskStore(db);
    const createCompleted = (taskId: string, timestamp: string) => {
      store.create({ taskId, taskType: "background_agent", goal: taskId, now: timestamp });
      store.transition(taskId, "running", { now: timestamp });
      store.transition(taskId, "verifying", { now: new Date(Date.parse(timestamp) + 1).toISOString() });
      store.transition(taskId, "completed", { now: new Date(Date.parse(timestamp) + 2).toISOString() });
    };
    createCompleted("old-job", "2026-09-01T00:00:00.000Z");
    createCompleted("recent-1", "2026-10-30T00:00:00.000Z");
    createCompleted("recent-2", "2026-10-30T00:00:01.000Z");
    store.create({ taskId: "still-running", taskType: "background_agent", goal: "keep me" });
    store.transition("still-running", "running");

    expect(store.pruneTerminal({ now: "2026-10-31T00:00:00.000Z", retentionMs: 30 * 24 * 60 * 60 * 1_000, maxRecords: 1, taskType: "background_agent" })).toBe(2);
    expect(store.get("old-job")).toBeNull();
    expect(store.get("recent-1")).toBeNull();
    expect(store.get("recent-2")?.status).toBe("completed");
    expect(store.get("still-running")?.status).toBe("running");
  });

  it("rejects invalid transitions without writing an event", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "task-4", goal: "do not skip" });

    expect(() => store.transition("task-4", "completed")).toThrow(/Invalid task state transition/);
    expect(store.get("task-4")?.status).toBe("queued");
    expect(store.listEvents("task-4")).toHaveLength(1);
  });

  it("persists terminal output and failure details", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "task-5", goal: "persist output", now: "2026-10-15T00:00:00.000Z" });
    store.transition("task-5", "running", { now: "2026-10-15T00:00:01.000Z" });
    store.transition("task-5", "verifying", { now: "2026-10-15T00:00:02.000Z" });
    store.transition("task-5", "completed", {
      now: "2026-10-15T00:00:03.000Z",
      result: "verified output",
    });
    expect(store.get("task-5")).toMatchObject({ status: "completed", result: "verified output" });

    store.create({ taskId: "task-6", goal: "persist error", now: "2026-10-15T00:00:00.000Z" });
    store.transition("task-6", "running", { now: "2026-10-15T00:00:01.000Z" });
    store.transition("task-6", "failed", {
      now: "2026-10-15T00:00:02.000Z",
      reason: "execution failed",
      error: "provider unavailable",
    });
    expect(store.get("task-6")).toMatchObject({ status: "failed", lastError: "provider unavailable" });
  });

  it("persists typed background payloads, enforces idempotency, and claims only the matching queue", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "tracked", goal: "chat run" });
    const input = {
      taskId: "background-1",
      taskType: "background_agent",
      goal: "audit the workspace",
      sessionId: "session-a",
      payload: { prompt: "audit the workspace", source: "webchat" },
      idempotencyKey: "session-a:audit-1",
    };
    const first = store.create(input);
    expect(first).toMatchObject({ taskId: "background-1", taskType: "background_agent", payload: input.payload });
    expect(store.create({ ...input, taskId: "ignored-duplicate" }).taskId).toBe("background-1");
    expect(store.claimNext(undefined, 5_000, { taskType: "background_agent", workerId: "worker-a" })).toMatchObject({
      taskId: "background-1", status: "running", workerId: "worker-a",
    });
    expect(store.get("tracked")?.status).toBe("queued");
  });

  it("fences stale workers and records write-action results for replay", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "fenced", taskType: "background_agent", goal: "safe job" });
    const claimed = store.claimNext(undefined, 5_000, { taskType: "background_agent", workerId: "worker-a" })!;
    const oldToken = claimed.leaseToken!;
    expect(store.claimAction("fenced", "blocked-action", "file_write", "stale-token")).toEqual({ status: "lease_lost" });
    expect(store.renewLease("fenced", undefined, 5_000, "stale-token")).toBe(false);
    expect(() => store.transition("fenced", "verifying", { leaseToken: "stale-token" })).toThrow(/lease/i);

    expect(store.claimAction("fenced", "action-1", "file_write", oldToken)).toEqual({ status: "execute" });
    store.completeAction("fenced", "action-1", { written: true }, oldToken);
    expect(store.claimAction("fenced", "action-1", "file_write", oldToken)).toEqual({ status: "completed", result: { written: true } });
    expect(store.claimAction("fenced", "action-2", "browser_click", oldToken)).toEqual({ status: "execute" });
    store.failAction("fenced", "action-2", "connection dropped after click", oldToken);
    expect(store.claimAction("fenced", "action-2", "browser_click", oldToken)).toEqual({ status: "needs_reconciliation", error: "connection dropped after click" });
    expect(store.listUnsettledActions("fenced")).toEqual([{ actionKey: "action-2", toolName: "browser_click", status: "failed", error: "connection dropped after click" }]);
    expect(store.get("fenced")?.leaseToken).toBe(oldToken);
  });

  it("rejects an expired lease before another worker has reclaimed the task", () => {
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const store = new DurableTaskStore(db, now);
    store.create({ taskId: "expired-lease", taskType: "background_agent", goal: "fenced expiry" });
    const claimed = store.claimNext(now(), 1_000, { taskType: "background_agent", workerId: "worker-old" })!;
    const oldToken = claimed.leaseToken!;

    clock += 1_001;
    expect(store.renewLease("expired-lease", now(), 1_000, oldToken)).toBe(false);
    expect(store.updateProgress("expired-lease", { progress: 50, now: now(), leaseToken: oldToken })).toBe(false);
    expect(store.claimAction("expired-lease", "late-write", "file_write", oldToken)).toEqual({ status: "lease_lost" });
    expect(() => store.transition("expired-lease", "verifying", { now: now(), leaseToken: oldToken })).toThrow(/expired/i);

    store.recoverExpired(now(), { taskType: "background_agent" });
    const reclaimed = store.claimNext(now(), 1_000, { taskType: "background_agent", workerId: "worker-new" })!;
    expect(reclaimed.leaseToken).not.toBe(oldToken);
    expect(store.claimAction("expired-lease", "late-write", "file_write", reclaimed.leaseToken!)).toEqual({ status: "execute" });
  });


  it("fences late action results from an expired worker after another worker reclaims the task", () => {
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const store = new DurableTaskStore(db, now);
    store.create({ taskId: "late-action", taskType: "background_agent", goal: "never accept stale writes" });
    const first = store.claimNext(now(), 1_000, { taskType: "background_agent", workerId: "old-worker" })!;
    expect(store.claimAction("late-action", "action", "browser_click", first.leaseToken!)).toEqual({ status: "execute" });

    clock += 1_001;
    // An in-flight external action with no recorded outcome parks the task for reconciliation.
    expect(store.recoverExpired(now(), { taskType: "background_agent" })).toMatchObject([{ status: "needs_reconciliation" }]);
    store.reconcileAction("late-action", "action", { outcome: "not_applied", evidence: { checked: true }, now: now() });
    store.resumeAfterReconciliation("late-action", { operatorConfirmed: true }, now());
    const second = store.claimNext(now(), 5_000, { taskType: "background_agent", workerId: "new-worker" })!;
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(() => store.completeAction("late-action", "action", { clicked: true }, first.leaseToken!)).toThrow(/lease was lost/i);
    expect(store.failAction("late-action", "action", "late failure", first.leaseToken!)).toBe(false);
    expect(store.claimAction("late-action", "action", "browser_click", second.leaseToken!)).toEqual({ status: "execute" });
  });

  it("accepts checkpoints larger than the former 1 MiB ceiling and rejects oversized snapshots", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "large-checkpoint", taskType: "background_agent", goal: "long task" });
    const claimed = store.claimNext(undefined, 60_000, { taskType: "background_agent" })!;
    const payload = "x".repeat(2 * 1024 * 1024);
    expect(store.updateProgress("large-checkpoint", { progress: 40, checkpoint: { payload }, leaseToken: claimed.leaseToken })).toBe(true);
    expect(() => store.updateProgress("large-checkpoint", {
      checkpoint: { payload: "x".repeat(9 * 1024 * 1024) },
      leaseToken: claimed.leaseToken,
    })).toThrow(/checkpoint exceeds 8388608 bytes/);
  });

  it("cancels queued work immediately and flags running work for cooperative cancellation", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "queued-cancel", taskType: "background_agent", goal: "not started" });
    expect(store.requestCancel("queued-cancel")).toMatchObject({ accepted: true, status: "cancelled" });
    store.create({ taskId: "running-cancel", taskType: "background_agent", goal: "currently running" });
    store.claimNext(undefined, 5_000, { taskType: "background_agent" });
    expect(store.requestCancel("running-cancel")).toMatchObject({ accepted: true, status: "running" });
    expect(store.get("running-cancel")?.cancelRequestedAt).toBeTruthy();
  });


  it("treats max_attempts=-1 as unbounded during expired-lease recovery", () => {
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const store = new DurableTaskStore(db, now);
    store.create({ taskId: "unbounded-recovery", taskType: "background_agent", goal: "keep recovering", maxAttempts: -1, now: now() });
    store.claimNext(now(), 100, { taskType: "background_agent" });
    clock += 101;
    expect(store.recoverExpired(now(), { taskType: "background_agent" })).toMatchObject([
      { taskId: "unbounded-recovery", status: "retrying", maxAttempts: -1, attemptCount: 1 },
    ]);
    clock += 1;
    expect(store.claimNext(now(), 100, { taskType: "background_agent" })).toMatchObject({ status: "running", attemptCount: 2 });
  });

  it("recovers expired verification leases instead of leaving tasks stuck forever", () => {
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const store = new DurableTaskStore(db, now);
    store.create({ taskId: "verify-crash", taskType: "background_agent", goal: "recover verifier", maxAttempts: -1, now: now() });
    store.claimNext(now(), 100, { taskType: "background_agent" });
    store.transition("verify-crash", "verifying", { now: now(), result: "prepared" });
    clock += 101;
    expect(store.recoverExpired(now(), { taskType: "background_agent" })).toMatchObject([
      { taskId: "verify-crash", status: "retrying", result: "prepared" },
    ]);
  });

  it("moves expired tasks with uncertain external actions to reconciliation, then safely resumes after evidence", () => {
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const store = new DurableTaskStore(db, now);
    store.create({ taskId: "uncertain-recovery", taskType: "background_agent", goal: "reconcile write", maxAttempts: -1, now: now() });
    const claim = store.claimNext(now(), 100, { taskType: "background_agent" })!;
    store.claimAction("uncertain-recovery", "write-1", "file_write", claim.leaseToken!);
    clock += 101;
    expect(store.recoverExpired(now(), { taskType: "background_agent" })).toMatchObject([
      { status: "needs_reconciliation", errorCategory: "uncertain_side_effect" },
    ]);
    expect(store.listUnsettledActions("uncertain-recovery")).toMatchObject([
      { actionKey: "write-1", toolName: "file_write", status: "running" },
    ]);
    store.reconcileAction("uncertain-recovery", "write-1", {
      outcome: "not_applied", evidence: { checked: true, resourceState: "unchanged" }, now: now(),
    });
    expect(store.listUnsettledActions("uncertain-recovery")).toHaveLength(0);
    const resumed = store.resumeAfterReconciliation("uncertain-recovery", { operatorConfirmed: true }, now());
    expect(resumed).toMatchObject({
      status: "queued",
      verificationResult: { reconciled: true, reconciliationEvidence: { operatorConfirmed: true } },
    });
    expect(resumed.errorCategory).toBeUndefined();
  });

  it("persists dependency gates, rejects cycles, and unblocks dependents when prerequisites complete", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "dep-a", taskType: "background_agent", goal: "first" });
    store.create({ taskId: "dep-b", taskType: "background_agent", goal: "second", dependencies: ["dep-a"] });
    store.create({ taskId: "dep-cycle-a", taskType: "background_agent", goal: "cycle a" });
    store.create({ taskId: "dep-cycle-b", taskType: "background_agent", goal: "cycle b", dependencies: ["dep-cycle-a"] });
    expect(() => store.setDependencies("dep-cycle-a", ["dep-cycle-b"])).toThrow(/cycle/i);
    expect(store.claimNext(undefined, 5_000, { taskType: "background_agent" })?.taskId).toBe("dep-a");
    // dep-b stays gated behind dep-a; only the independent cycle root is claimable.
    expect(store.claimNext(undefined, 5_000, { taskType: "background_agent" })?.taskId).toBe("dep-cycle-a");
    expect(store.claimNext(undefined, 5_000, { taskType: "background_agent" })).toBeNull();
    store.transition("dep-a", "verifying");
    store.transition("dep-a", "completed");
    expect(store.get("dep-b")?.status).toBe("queued");
    expect(store.claimNext(undefined, 5_000, { taskType: "background_agent" })?.taskId).toBe("dep-b");
  });

  it("blocks retrying dependents when a prerequisite fails", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "retry-dep", taskType: "background_agent", goal: "prerequisite" });
    store.create({ taskId: "retry-child", taskType: "background_agent", goal: "dependent", dependencies: ["retry-dep"] });
    // Simulate an older or externally resumed task already waiting for retry.
    store.transition("retry-child", "running");
    store.transition("retry-child", "retrying", { nextRetryAt: new Date(Date.now() + 60_000).toISOString() });
    store.transition("retry-dep", "running");
    store.transition("retry-dep", "failed", { error: "prerequisite failed" });
    expect(store.get("retry-child")).toMatchObject({ status: "blocked", errorCategory: "dependency_blocked" });
  });

  it("does not cascade dependency-blocked state through an entire task graph", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "chain-a", taskType: "background_agent", goal: "root dependency" });
    store.create({ taskId: "chain-b", taskType: "background_agent", goal: "middle step", dependencies: ["chain-a"] });
    store.create({ taskId: "chain-c", taskType: "background_agent", goal: "downstream step", dependencies: ["chain-b"] });
    store.transition("chain-a", "running");
    store.transition("chain-a", "failed", { error: "temporary blocker" });
    expect(store.get("chain-b")).toMatchObject({ status: "blocked", errorCategory: "dependency_blocked" });
    expect(store.get("chain-c")?.status).toBe("queued");
    expect(store.claimNext(undefined, 5_000, { taskType: "background_agent" })).toBeNull();

    store.resumeAfterReconciliation("chain-a", { repaired: true });
    store.transition("chain-a", "running");
    store.transition("chain-a", "verifying");
    store.transition("chain-a", "completed");
    expect(store.get("chain-b")?.status).toBe("queued");
    let task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    expect(task.taskId).toBe("chain-b");
    store.transition(task.taskId, "verifying", { leaseToken: task.leaseToken });
    store.transition(task.taskId, "completed", { leaseToken: task.leaseToken });
    task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    expect(task.taskId).toBe("chain-c");
  });

  it("automatically requeues dependency-blocked work after its prerequisite is owner-retried and completed", () => {
    const store = new DurableTaskStore(db);
    store.create({ taskId: "dep-fail", taskType: "background_agent", goal: "recover prerequisite" });
    store.create({ taskId: "dep-wait", taskType: "background_agent", goal: "wait for prerequisite", dependencies: ["dep-fail"] });
    store.transition("dep-fail", "running");
    store.transition("dep-fail", "failed", { error: "temporary but corrected" });
    expect(store.get("dep-wait")).toMatchObject({ status: "blocked", errorCategory: "dependency_blocked" });
    store.resumeAfterReconciliation("dep-fail", { issueFixed: true });
    store.transition("dep-fail", "running");
    store.transition("dep-fail", "verifying");
    store.transition("dep-fail", "completed");
    expect(store.get("dep-wait")?.status).toBe("queued");
  });

  it("resolves regenerated child and verifier IDs when an idempotent plan is resubmitted", () => {
    const store = new DurableTaskStore(db);
    const first = store.createPlan({
      parent: {
        taskId: "idempotent-generated-root-a", taskType: "background_goal", goal: "repeatable generated plan",
        idempotencyKey: "generated-plan-key", verificationSpec: { kind: "goal_verifier_child", finalVerifierTaskId: "generated-check-a" },
      },
      children: [
        { taskId: "generated-work-a", taskType: "background_agent", goal: "work", idempotencyKey: "generated-work-key" },
        { taskId: "generated-check-a", taskType: "background_agent", goal: "verify", idempotencyKey: "generated-check-key", dependencies: ["generated-work-a"] },
      ],
    });
    const second = store.createPlan({
      parent: {
        taskId: "idempotent-generated-root-b", taskType: "background_goal", goal: "repeatable generated plan",
        idempotencyKey: "generated-plan-key", verificationSpec: { kind: "goal_verifier_child", finalVerifierTaskId: "generated-check-b" },
      },
      children: [
        { taskId: "generated-work-b", taskType: "background_agent", goal: "work", idempotencyKey: "generated-work-key" },
        { taskId: "generated-check-b", taskType: "background_agent", goal: "verify", idempotencyKey: "generated-check-key", dependencies: ["generated-work-b"] },
      ],
    });
    expect(second.parent.taskId).toBe(first.parent.taskId);
    expect(second.children.map((task) => task.taskId)).toEqual(first.children.map((task) => task.taskId));
    expect(second.parent.verificationSpec?.finalVerifierTaskId).toBe(first.children[1]?.taskId);
    expect(store.listDependencies(first.children[1]!.taskId).map((item) => item.dependsOnTaskId)).toEqual([first.children[0]!.taskId]);
  });

  it("creates an idempotent parent-child DAG and completes its parent only after the verifier child passes", () => {
    const store = new DurableTaskStore(db);
    const plan = {
      parent: { taskId: "goal-root", taskType: "background_goal", goal: "deliver a tested feature", maxAttempts: -1, idempotencyKey: "plan-1", verificationSpec: { kind: "goal_verifier_child", finalVerifierTaskId: "goal-check" } },
      children: [
        { taskId: "goal-build", taskType: "background_agent", goal: "build it", maxAttempts: -1, idempotencyKey: "plan-1:build" },
        { taskId: "goal-test", taskType: "background_agent", goal: "test it", maxAttempts: -1, idempotencyKey: "plan-1:test", dependencies: ["goal-build"] },
        { taskId: "goal-check", taskType: "background_agent", goal: "verify it", maxAttempts: -1, idempotencyKey: "plan-1:check", verificationSpec: { kind: "goal_verifier" }, dependencies: ["goal-build", "goal-test"] },
      ],
    };
    const created = store.createPlan(plan);
    expect(created.parent.status).toBe("queued");
    expect(store.createPlan(plan).children.map((item) => item.taskId)).toEqual(["goal-build", "goal-test", "goal-check"]);
    const changedDependencies = {
      ...plan,
      children: plan.children.map((child, index) => index === 1
        ? { ...child, dependencies: ["goal-build", "unknown-extra"] }
        : child),
    };
    expect(() => store.createPlan(changedDependencies)).toThrow(/different dependencies/i);
    expect(store.claimNext(undefined, 5_000, { taskType: "background_goal" })).toBeNull();
    let task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    expect(task.taskId).toBe("goal-build");
    store.transition(task.taskId, "verifying", { leaseToken: task.leaseToken, result: "built" });
    store.transition(task.taskId, "completed", { leaseToken: task.leaseToken, verificationResult: { passed: true } });
    task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    expect(task.taskId).toBe("goal-test");
    store.transition(task.taskId, "verifying", { leaseToken: task.leaseToken, result: "tested" });
    store.transition(task.taskId, "completed", { leaseToken: task.leaseToken, verificationResult: { passed: true } });
    task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    expect(task.taskId).toBe("goal-check");
    store.transition(task.taskId, "verifying", { leaseToken: task.leaseToken, result: "{\"passed\":true}" });
    store.transition(task.taskId, "completed", { leaseToken: task.leaseToken, verificationResult: { passed: true, evidence: ["verified"] } });
    expect(store.get("goal-root")).toMatchObject({ status: "completed", progress: 100 });
    expect(store.getTaskTree("goal-root")?.children).toHaveLength(3);
  });

  it("completes a simple goal parent only after all child tasks complete", () => {
    const store = new DurableTaskStore(db);
    store.createPlan({
      parent: { taskId: "simple-root", taskType: "background_goal", goal: "simple goal" },
      children: [{ taskId: "simple-child", taskType: "background_agent", goal: "do work" }],
    });
    const task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    store.transition(task.taskId, "verifying", { leaseToken: task.leaseToken });
    store.transition(task.taskId, "completed", { leaseToken: task.leaseToken, verificationResult: { passed: true } });
    expect(store.get("simple-root")).toMatchObject({
      status: "completed", progress: 100,
      verificationResult: { passed: true, method: "all_child_tasks_completed", childTaskIds: ["simple-child"] },
    });
  });

  it("replans a goal by superseding a failed step and rewiring downstream tasks and final verification", () => {
    const store = new DurableTaskStore(db);
    store.createPlan({
      parent: {
        taskId: "replan-root", taskType: "background_goal", goal: "complete revised goal",
        verificationSpec: { kind: "goal_verifier_child", finalVerifierTaskId: "replan-check" },
      },
      children: [
        { taskId: "replan-old", taskType: "background_agent", goal: "old broken step", idempotencyKey: "replan:old" },
        { taskId: "replan-downstream", taskType: "background_agent", goal: "downstream", idempotencyKey: "replan:downstream", dependencies: ["replan-old"] },
        { taskId: "replan-check", taskType: "background_agent", goal: "final verification", idempotencyKey: "replan:check", dependencies: ["replan-downstream"] },
      ],
    });
    store.transition("replan-old", "running");
    store.transition("replan-old", "failed", { error: "broken implementation" });
    expect(store.get("replan-downstream")?.status).toBe("blocked");
    // Dependency-blocked waiting does not cascade; the claim gate still holds the verifier back.
    expect(store.get("replan-check")?.status).toBe("queued");

    const revision = {
      supersedeTaskIds: ["replan-old"],
      replacements: [{
        taskId: "replan-new", taskType: "background_agent", goal: "repair implementation",
        idempotencyKey: "replan:new", payload: { planStepId: "repair" }, maxAttempts: -1,
      }],
    };
    const result = store.replan("replan-root", revision);
    expect(result.superseded).toMatchObject([{ taskId: "replan-old", status: "superseded" }]);
    expect(result.replacements).toMatchObject([{ taskId: "replan-new", status: "queued" }]);
    expect(store.listDependencies("replan-downstream").map((item) => item.dependsOnTaskId)).toEqual(["replan-new"]);
    // The final verifier also waits for every replacement step.
    expect(store.listDependencies("replan-check").map((item) => item.dependsOnTaskId)).toEqual(["replan-downstream", "replan-new"]);
    expect(store.get("replan-check")?.status).toBe("queued");
    expect(store.replan("replan-root", revision).replacements[0]?.taskId).toBe("replan-new");

    let task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    expect(task.taskId).toBe("replan-new");
    store.transition(task.taskId, "verifying", { leaseToken: task.leaseToken });
    store.transition(task.taskId, "completed", { leaseToken: task.leaseToken, verificationResult: { passed: true } });
    task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    expect(task.taskId).toBe("replan-downstream");
    store.transition(task.taskId, "verifying", { leaseToken: task.leaseToken });
    store.transition(task.taskId, "completed", { leaseToken: task.leaseToken, verificationResult: { passed: true } });
    task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    expect(task.taskId).toBe("replan-check");
  });

  it("adds an append-only repair step and reruns a blocked final goal verifier", () => {
    const store = new DurableTaskStore(db);
    store.createPlan({
      parent: {
        taskId: "append-repair-root", taskType: "background_goal", goal: "deliver repaired result",
        verificationSpec: { kind: "goal_verifier_child", finalVerifierTaskId: "append-repair-check" },
      },
      children: [
        { taskId: "append-repair-work", taskType: "background_agent", goal: "initial work" },
        { taskId: "append-repair-check", taskType: "background_agent", goal: "final verifier", verificationSpec: { kind: "goal_verifier" }, dependencies: ["append-repair-work"] },
      ],
    });
    let task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    store.transition(task.taskId, "verifying", { leaseToken: task.leaseToken });
    store.transition(task.taskId, "completed", { leaseToken: task.leaseToken, verificationResult: { passed: true } });
    task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    expect(task.taskId).toBe("append-repair-check");
    store.transition(task.taskId, "verifying", { leaseToken: task.leaseToken });
    store.transition(task.taskId, "blocked", { leaseToken: task.leaseToken, error: "goal evidence was incomplete", errorCategory: "permanent_validation" });

    const revision = {
      supersedeTaskIds: [],
      replacements: [{ taskId: "append-repair-fix", taskType: "background_agent", goal: "add missing evidence", idempotencyKey: "append-repair:fix" }],
    };
    const revised = store.replan("append-repair-root", revision);
    expect(revised.superseded).toHaveLength(0);
    expect(revised.replacements[0]?.taskId).toBe("append-repair-fix");
    expect(store.get("append-repair-check")?.status).toBe("queued");
    expect(store.listDependencies("append-repair-check").map((item) => item.dependsOnTaskId)).toEqual(["append-repair-work", "append-repair-fix"]);
    expect(store.replan("append-repair-root", revision).replacements[0]?.taskId).toBe("append-repair-fix");

    task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    expect(task.taskId).toBe("append-repair-fix");
    store.transition(task.taskId, "verifying", { leaseToken: task.leaseToken });
    store.transition(task.taskId, "completed", { leaseToken: task.leaseToken, verificationResult: { passed: true } });
    task = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    expect(task.taskId).toBe("append-repair-check");
  });

  it("refuses to supersede running or uncertain external actions during replanning", () => {
    const store = new DurableTaskStore(db);
    store.createPlan({
      parent: { taskId: "unsafe-replan-root", taskType: "background_goal", goal: "unsafe" },
      children: [{ taskId: "unsafe-running", taskType: "background_agent", goal: "in flight" }],
    });
    store.claimNext(undefined, 5_000, { taskType: "background_agent" });
    expect(() => store.replan("unsafe-replan-root", {
      supersedeTaskIds: ["unsafe-running"], replacements: [{ taskId: "unsafe-new", goal: "replacement", idempotencyKey: "unsafe:new" }],
    })).toThrow(/cannot be superseded from state running/i);
  });

  it("refuses to supersede a failed step while its external action is unsettled", () => {
    const store = new DurableTaskStore(db);
    store.createPlan({
      parent: { taskId: "uncertain-replan-root", taskType: "background_goal", goal: "uncertain plan" },
      children: [{ taskId: "uncertain-replan-child", taskType: "background_agent", goal: "write file" }],
    });
    const claimed = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    store.claimAction(claimed.taskId, "write-file", "file_write", claimed.leaseToken!);
    store.failAction(claimed.taskId, "write-file", "write result not confirmed", claimed.leaseToken!);
    store.transition(claimed.taskId, "failed", { leaseToken: claimed.leaseToken, error: "worker lost response" });
    expect(() => store.replan("uncertain-replan-root", {
      supersedeTaskIds: ["uncertain-replan-child"],
      replacements: [{ taskId: "uncertain-replan-replacement", taskType: "background_agent", goal: "redo write", idempotencyKey: "uncertain-replan:replacement" }],
    })).toThrow(/unsettled external actions/i);
  });

  it("keeps a parent non-terminal until running descendants observe cancellation", () => {
    const store = new DurableTaskStore(db);
    store.createPlan({
      parent: { taskId: "cancel-wait-root", taskType: "background_goal", goal: "cancel active goal" },
      children: [
        { taskId: "cancel-wait-running", taskType: "background_agent", goal: "active child" },
        { taskId: "cancel-wait-queued", taskType: "background_agent", goal: "queued child" },
      ],
    });
    const running = store.claimNext(undefined, 5_000, { taskType: "background_agent" })!;
    expect(running.taskId).toBe("cancel-wait-running");
    store.requestCancel("cancel-wait-root");
    expect(store.get("cancel-wait-running")?.cancelRequestedAt).toBeTruthy();
    expect(store.get("cancel-wait-queued")?.status).toBe("cancelled");
    expect(store.get("cancel-wait-root")?.status).not.toBe("cancelled");
    store.transition("cancel-wait-running", "cancelled", { leaseToken: running.leaseToken });
    expect(store.get("cancel-wait-root")).toMatchObject({ status: "cancelled" });
  });

  it("cascades parent cancellation to every non-terminal descendant", () => {
    const store = new DurableTaskStore(db);
    store.createPlan({
      parent: { taskId: "cancel-root", taskType: "background_goal", goal: "cancel plan" },
      children: [
        { taskId: "cancel-child-a", taskType: "background_agent", goal: "child a" },
        { taskId: "cancel-child-b", taskType: "background_agent", goal: "child b", dependencies: ["cancel-child-a"] },
      ],
    });
    expect(store.requestCancel("cancel-root").accepted).toBe(true);
    expect(store.get("cancel-root")?.status).toBe("cancelled");
    expect(store.listChildren("cancel-root").every((task) => task.status === "cancelled")).toBe(true);
  });

});
