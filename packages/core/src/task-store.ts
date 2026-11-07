import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  transitionTask,
  isTerminalTaskStatus,
  type TaskLifecycle,
  type TaskStatus,
} from "./task-state.js";

export interface CreateTaskInput {
  taskId?: string;
  goal: string;
  sessionId?: string;
  now?: string;
  maxAttempts?: number;
  taskType?: string;
  payload?: unknown;
  parentTaskId?: string;
  idempotencyKey?: string;
  /** Tasks with explicit acceptance criteria require a configured verifier before completion. */
  verificationSpec?: Record<string, unknown>;
  dependencies?: string[];
  priority?: number;
}

export interface CreateTaskPlanInput {
  parent: Omit<CreateTaskInput, "parentTaskId" | "dependencies">;
  children: Array<Omit<CreateTaskInput, "parentTaskId"> & { dependencies?: string[] }>;
}

export interface CreatedTaskPlan {
  parent: DurableTask;
  children: DurableTask[];
}

export interface ReplanTaskPlanInput {
  /** Existing direct children which the new plan intentionally replaces. */
  supersedeTaskIds: string[];
  /** Replacement steps. Dependencies may reference existing or replacement sibling task IDs. */
  replacements: Array<Omit<CreateTaskInput, "parentTaskId"> & { dependencies?: string[] }>;
}

export interface ReplannedTaskPlan {
  parent: DurableTask;
  superseded: DurableTask[];
  replacements: DurableTask[];
}

export interface DurableTask extends TaskLifecycle {
  goal: string;
  createdAt: string;
  sessionId?: string;
  leaseExpiresAt?: string;
  leaseToken?: string;
  workerId?: string;
  lastError?: string;
  result?: string;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt?: string;
  taskType: string;
  payload?: unknown;
  parentTaskId?: string;
  idempotencyKey?: string;
  progress?: number;
  checkpoint?: Record<string, unknown>;
  cancelRequestedAt?: string;
  priority: number;
  verificationSpec?: Record<string, unknown>;
  verificationResult?: Record<string, unknown>;
  errorCategory?: string;
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
  status: TaskStatus;
}

export interface TaskTreeNode {
  task: DurableTask;
  dependencies: TaskDependency[];
  children: TaskTreeNode[];
}

export interface TaskTransitionEvent {
  id: number;
  taskId: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus;
  version: number;
  reason?: string;
  createdAt: string;
}

interface TaskRow {
  task_id: string;
  goal: string;
  session_id: string | null;
  status: TaskStatus;
  version: number;
  lease_expires_at: string | null;
  lease_token: string | null;
  worker_id: string | null;
  last_error: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string | null;
  task_type: string;
  payload_json: string | null;
  parent_task_id: string | null;
  idempotency_key: string | null;
  progress: number | null;
  checkpoint_json: string | null;
  cancel_requested_at: string | null;
  priority: number;
  verification_spec_json: string | null;
  verification_result_json: string | null;
  error_category: string | null;
}

interface EventRow {
  id: number;
  task_id: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus;
  version: number;
  reason: string | null;
  created_at: string;
}

export type DurableActionClaim =
  | { status: "execute" }
  | { status: "completed"; result: unknown }
  | { status: "needs_reconciliation"; error?: string }
  | { status: "lease_lost" };

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_ACTION_RESULT_BYTES = 1024 * 1024;
const MAX_TASK_CHECKPOINT_BYTES = 8 * 1024 * 1024;

export class DurableTaskStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS miki_tasks (
        task_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        lease_expires_at TEXT,
        last_error TEXT,
        result TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_retry_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_miki_tasks_claim
        ON miki_tasks(status, lease_expires_at, updated_at);
      CREATE TABLE IF NOT EXISTS miki_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        version INTEGER NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES miki_tasks(task_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_miki_task_events_task
        ON miki_task_events(task_id, id);
      CREATE TABLE IF NOT EXISTS miki_background_job_actions (
        task_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
        result_json TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(task_id, action_key),
        FOREIGN KEY(task_id) REFERENCES miki_tasks(task_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_miki_background_actions_task
        ON miki_background_job_actions(task_id, updated_at);
      CREATE TABLE IF NOT EXISTS miki_task_dependencies (
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_id, depends_on_task_id),
        FOREIGN KEY(task_id) REFERENCES miki_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY(depends_on_task_id) REFERENCES miki_tasks(task_id) ON DELETE CASCADE,
        CHECK(task_id <> depends_on_task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_miki_task_dependencies_dependency
        ON miki_task_dependencies(depends_on_task_id, task_id);
    `);
    const columns = new Set((this.db.prepare("PRAGMA table_info(miki_tasks)").all() as Array<{ name: string }>).map((row) => row.name));
    const migrations: Array<[string, string]> = [
      ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
      ["max_attempts", "INTEGER NOT NULL DEFAULT 5"],
      ["next_retry_at", "TEXT"],
      ["task_type", "TEXT NOT NULL DEFAULT 'tracked_run'"],
      ["payload_json", "TEXT"],
      ["parent_task_id", "TEXT"],
      ["idempotency_key", "TEXT"],
      ["progress", "REAL"],
      ["checkpoint_json", "TEXT"],
      ["cancel_requested_at", "TEXT"],
      ["lease_token", "TEXT"],
      ["worker_id", "TEXT"],
      ["priority", "INTEGER NOT NULL DEFAULT 0"],
      ["verification_spec_json", "TEXT"],
      ["verification_result_json", "TEXT"],
      ["error_category", "TEXT"],
    ];
    for (const [name, definition] of migrations) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE miki_tasks ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_miki_tasks_retry_due ON miki_tasks(status,next_retry_at,updated_at);
      CREATE INDEX IF NOT EXISTS idx_miki_tasks_type_claim ON miki_tasks(task_type,status,next_retry_at,updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_miki_tasks_idempotency ON miki_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);
  }

  create(input: CreateTaskInput): DurableTask {
    const taskId = input.taskId ?? randomUUID();
    const timestamp = input.now ?? this.now();
    const requestedMaxAttempts = Number(input.maxAttempts ?? -1);
    // -1 is the persisted sentinel for an unbounded retry policy.
    const maxAttempts = requestedMaxAttempts === -1
      ? -1
      : Number.isFinite(requestedMaxAttempts) ? Math.max(1, Math.trunc(requestedMaxAttempts)) : 5;
    const taskType = String(input.taskType ?? "tracked_run").trim().slice(0, 80) || "tracked_run";
    let payloadJson: string | null;
    try { payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload) ?? null; }
    catch (error) { throw new Error(`Task payload is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`); }
    if (input.payload !== undefined && payloadJson === null) throw new Error("Task payload must be JSON-serializable.");
    let verificationSpecJson: string | null = null;
    try { verificationSpecJson = input.verificationSpec === undefined ? null : JSON.stringify(input.verificationSpec) ?? null; }
    catch (error) { throw new Error(`Task verification specification is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`); }
    if (input.verificationSpec !== undefined && verificationSpecJson === null) throw new Error("Task verification specification must be JSON-serializable.");
    if (verificationSpecJson && Buffer.byteLength(verificationSpecJson, "utf8") > MAX_PAYLOAD_BYTES) throw new Error(`Task verification specification exceeds ${MAX_PAYLOAD_BYTES} bytes.`);
    if (payloadJson && Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new Error(`Task payload exceeds ${MAX_PAYLOAD_BYTES} bytes.`);
    }
    if (!input.goal.trim()) throw new Error("Task goal must not be empty.");
    const task: DurableTask = {
      taskId,
      goal: input.goal,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      status: "queued",
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      attemptCount: 0,
      maxAttempts,
      taskType,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      priority: Number.isFinite(input.priority) ? Math.max(-100, Math.min(100, Math.trunc(input.priority!))) : 0,
      ...(input.verificationSpec ? { verificationSpec: input.verificationSpec } : {}),
    };
    // Lock the read/compare/insert sequence, not only the INSERT. This makes
    // idempotency safe across multiple gateway processes sharing one SQLite DB.
    const insert = this.db.transaction(() => {
      if (input.idempotencyKey) {
        const existing = this.db.prepare("SELECT * FROM miki_tasks WHERE idempotency_key=?").get(input.idempotencyKey) as TaskRow | undefined;
        if (existing) {
          const same = existing.goal === input.goal
            && existing.session_id === (input.sessionId ?? null)
            && existing.task_type === taskType
            && existing.payload_json === payloadJson
            && existing.parent_task_id === (input.parentTaskId ?? null)
            && existing.max_attempts === maxAttempts
            && existing.priority === task.priority
            && existing.verification_spec_json === verificationSpecJson;
          if (!same) throw new Error("Idempotency key is already in use for a different task payload.");
          return this.toTask(existing);
        }
      }
      this.db.prepare(`
        INSERT INTO miki_tasks(task_id,goal,session_id,status,version,attempt_count,max_attempts,next_retry_at,created_at,updated_at,task_type,payload_json,parent_task_id,idempotency_key,priority,verification_spec_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(task.taskId, task.goal, task.sessionId ?? null, task.status, task.version, 0, task.maxAttempts, null, timestamp, timestamp, taskType, payloadJson, input.parentTaskId ?? null, input.idempotencyKey ?? null, task.priority, verificationSpecJson);
      this.db.prepare(`
        INSERT INTO miki_task_events(task_id,from_status,to_status,version,reason,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(task.taskId, null, task.status, task.version, "task created", timestamp);
      if (input.dependencies?.length) this.setDependenciesInTransaction(task.taskId, input.dependencies, timestamp);
      return this.get(task.taskId)!;
    }).immediate();
    return insert;
  }

  /**
   * Creates a durable goal container and its child tasks atomically. Dependencies
   * may refer to another child in this plan or to an already persisted task.
   */
  createPlan(input: CreateTaskPlanInput): CreatedTaskPlan {
    if (!input.children.length) throw new Error("A task plan requires at least one child task.");
    const parentTaskId = input.parent.taskId ?? randomUUID();
    const children = input.children.map((child) => ({
      ...child,
      taskId: child.taskId ?? randomUUID(),
      parentTaskId,
      dependencies: undefined,
    }));
    const childIds = new Set(children.map((child) => child.taskId));
    if (childIds.size !== children.length) throw new Error("Task plan contains duplicate child task IDs.");
    if (childIds.has(parentTaskId)) throw new Error("A goal container cannot also be one of its child tasks.");
    if (input.parent.verificationSpec?.kind === "goal_verifier_child") {
      const verifierTaskId = input.parent.verificationSpec.finalVerifierTaskId;
      if (typeof verifierTaskId !== "string" || !childIds.has(verifierTaskId)) {
        throw new Error("A goal_verifier_child plan must reference its final verifier child task ID.");
      }
    }
    if (input.parent.idempotencyKey && input.children.some((child) => !child.idempotencyKey)) {
      throw new Error("Every child in an idempotent task plan must have its own idempotency key.");
    }
    const execute = this.db.transaction(() => {
      if (input.parent.idempotencyKey) {
        const existingRow = this.db.prepare("SELECT * FROM miki_tasks WHERE idempotency_key=?")
          .get(input.parent.idempotencyKey) as TaskRow | undefined;
        if (existingRow) {
          const existingParent = this.toTask(existingRow);
          // A caller may regenerate task IDs while retrying the same plan. Resolve
          // its child IDs and final-verifier reference to the persisted plan before
          // comparing payloads, parent ownership, or dependency edges.
          const existingChildren = this.listChildren(existingParent.taskId);
          if (existingChildren.length !== children.length) {
            throw new Error("Task plan idempotency key is already in use for a different plan.");
          }
          const existingByIdempotency = new Map(existingChildren.map((child) => [child.idempotencyKey, child]));
          const resolvedChildren = children.map((child) => {
            const existing = child.idempotencyKey
              ? existingByIdempotency.get(child.idempotencyKey)
              : existingChildren.find((candidate) => candidate.taskId === child.taskId);
            if (!existing) throw new Error("Task plan idempotency key is already in use for a different plan.");
            const resolved = this.create({ ...child, taskId: existing.taskId, parentTaskId: existingParent.taskId });
            if (resolved.parentTaskId !== existingParent.taskId) throw new Error("Task plan child belongs to another goal.");
            return resolved;
          });
          const resolvedTaskIds = new Map(children.map((child, index) => [child.taskId!, resolvedChildren[index].taskId]));
          const requestedVerifierId = input.parent.verificationSpec?.finalVerifierTaskId;
          const resolvedVerificationSpec = input.parent.verificationSpec && typeof requestedVerifierId === "string"
            ? { ...input.parent.verificationSpec, finalVerifierTaskId: resolvedTaskIds.get(requestedVerifierId) ?? requestedVerifierId }
            : input.parent.verificationSpec;
          const resolvedParent = this.create({
            ...input.parent,
            taskId: existingParent.taskId,
            ...(resolvedVerificationSpec ? { verificationSpec: resolvedVerificationSpec } : {}),
          });
          for (let index = 0; index < resolvedChildren.length; index += 1) {
            const expectedDependencies = (input.children[index].dependencies ?? [])
              .map((dependencyId) => resolvedTaskIds.get(dependencyId) ?? dependencyId)
              .sort();
            const actualDependencies = this.listDependencies(resolvedChildren[index].taskId).map((item) => item.dependsOnTaskId).sort();
            if (JSON.stringify(expectedDependencies) !== JSON.stringify(actualDependencies)) {
              throw new Error(`Task plan idempotency key is already in use with different dependencies for child ${resolvedChildren[index].taskId}.`);
            }
          }
          return { parent: resolvedParent, children: resolvedChildren };
        }
      }
      const parent = this.create({ ...input.parent, taskId: parentTaskId });
      for (let index = 0; index < children.length; index += 1) {
        this.create(children[index]);
      }
      for (let index = 0; index < children.length; index += 1) {
        const deps = input.children[index].dependencies ?? [];
        if (deps.length) this.setDependenciesInTransaction(children[index].taskId!, deps, input.parent.now ?? this.now());
      }
      this.reconcileHierarchyInTransaction(input.parent.now ?? this.now());
      return { parent: this.get(parent.taskId)!, children: children.map((child) => this.get(child.taskId!)!) };
    });
    return execute.immediate();
  }

  /**
   * Revises an active goal without losing its durable history. Only unstarted,
   * dependency-blocked, retrying or failed children with no uncertain external
   * side effects may be superseded. Downstream edges and the final verifier are
   * rewired atomically to every replacement step.
   */
  replan(parentTaskId: string, input: ReplanTaskPlanInput, now = this.now()): ReplannedTaskPlan {
    const supersedeIds = [...new Set(input.supersedeTaskIds.map((id) => String(id).trim()).filter(Boolean))];
    if (supersedeIds.length !== input.supersedeTaskIds.length) throw new Error("Superseded task IDs must be unique and non-empty when supplied.");
    if (!input.replacements.length) throw new Error("A replan must include at least one replacement or additive repair step.");
    if (input.replacements.some((item) => !item.idempotencyKey?.trim())) {
      throw new Error("Every replacement step requires an idempotency key so a retried replan cannot duplicate work.");
    }
    const replacementInputs = input.replacements.map((item) => ({ ...item, taskId: item.taskId ?? randomUUID(), parentTaskId: parentTaskId, dependencies: undefined }));
    const replacementIds = new Set(replacementInputs.map((item) => item.taskId));
    if (replacementIds.size !== replacementInputs.length) throw new Error("Replacement plan contains duplicate task IDs.");
    if (supersedeIds.some((id) => replacementIds.has(id))) throw new Error("A task cannot be superseded and reused as a replacement.");

    const execute = this.db.transaction(() => {
      const parent = this.get(parentTaskId);
      if (!parent) throw new Error(`Cannot replan missing goal ${parentTaskId}.`);
      const children = this.listChildren(parentTaskId);
      const childById = new Map(children.map((child) => [child.taskId, child]));
      // A repeated revision request is an idempotent read when all replacement
      // rows already exist and every requested old step is recorded superseded.
      const existingReplacements = replacementInputs.map((replacement) => replacement.idempotencyKey
        ? this.db.prepare("SELECT task_id FROM miki_tasks WHERE idempotency_key=?").get(replacement.idempotencyKey) as { task_id: string } | undefined
        : undefined);
      if (existingReplacements.every(Boolean) && supersedeIds.every((id) => childById.get(id)?.status === "superseded")) {
        const tasks = replacementInputs.map((replacement, index) => {
          const existing = this.create(replacement);
          if (existing.taskId !== existingReplacements[index]!.task_id || existing.parentTaskId !== parentTaskId) {
            throw new Error("A replan idempotency key is already bound to a different goal revision.");
          }
          return existing;
        });
        const existingReplacementMap = new Map(replacementInputs.map((item, index) => [item.taskId, tasks[index]]));
        for (let index = 0; index < input.replacements.length; index += 1) {
          const wanted = (input.replacements[index].dependencies ?? []).map((id) => existingReplacementMap.get(id)?.taskId ?? id).sort();
          const actual = this.listDependencies(tasks[index].taskId).map((dependency) => dependency.dependsOnTaskId).sort();
          if (JSON.stringify(wanted) !== JSON.stringify(actual)) throw new Error("A repeated replan request changed its dependency contract.");
        }
        return { parent: this.get(parentTaskId)!, superseded: supersedeIds.map((id) => childById.get(id)!), replacements: tasks };
      }
      if (isTerminalTaskStatus(parent.status) || parent.cancelRequestedAt) throw new Error(`Goal ${parentTaskId} is not active and cannot be replanned.`);
      const superseded = supersedeIds.map((id) => {
        const task = childById.get(id);
        if (!task) throw new Error(`Task ${id} is not a direct child of goal ${parentTaskId}.`);
        if (!["queued", "blocked", "retrying", "failed"].includes(task.status)) {
          throw new Error(`Task ${id} cannot be superseded from state ${task.status}; running or uncertain work must be reconciled first.`);
        }
        if (this.listUnsettledActions(id).length) throw new Error(`Task ${id} has unsettled external actions and cannot be superseded safely.`);
        return task;
      });
      const finalVerifierId = typeof parent.verificationSpec?.finalVerifierTaskId === "string"
        ? parent.verificationSpec.finalVerifierTaskId : undefined;
      const finalVerifier = finalVerifierId ? childById.get(finalVerifierId) : undefined;
      if (finalVerifierId && (!finalVerifier || !["queued", "blocked"].includes(finalVerifier.status))) {
        throw new Error("The goal verifier has already started; this plan can no longer be revised safely.");
      }
      if (finalVerifierId && supersedeIds.includes(finalVerifierId)) {
        throw new Error("The designated final verifier cannot be superseded; replace work steps and keep the verifier intact.");
      }

      const created: DurableTask[] = [];
      for (const replacement of replacementInputs) {
        const task = this.create(replacement);
        if (task.parentTaskId !== parentTaskId) throw new Error(`Replacement idempotency key for ${task.taskId} belongs to another goal.`);
        created.push(task);
      }
      const createdByRequestedId = new Map(replacementInputs.map((item, index) => [item.taskId, created[index]]));
      for (let index = 0; index < input.replacements.length; index += 1) {
        const requested = input.replacements[index];
        const actual = created[index];
        const deps = requested.dependencies ?? [];
        if (deps.some((id) => supersedeIds.includes(id))) throw new Error(`Replacement ${actual.taskId} cannot depend on a step being superseded.`);
        for (const dependencyId of deps) {
          const replacementDependency = createdByRequestedId.get(dependencyId);
          const existingDependency = childById.get(dependencyId);
          if (!replacementDependency && !existingDependency) {
            throw new Error(`Replacement ${actual.taskId} must depend only on a sibling task in goal ${parentTaskId}: ${dependencyId}.`);
          }
          if (existingDependency && existingDependency.status === "superseded") {
            throw new Error(`Replacement ${actual.taskId} cannot depend on already superseded task ${dependencyId}.`);
          }
        }
        const resolvedDeps = deps.map((id) => createdByRequestedId.get(id)?.taskId ?? id);
        const currentDeps = this.listDependencies(actual.taskId).map((item) => item.dependsOnTaskId).sort();
        if (["queued", "blocked"].includes(actual.status)) {
          this.setDependenciesInTransaction(actual.taskId, resolvedDeps, now);
        } else if (JSON.stringify(currentDeps) !== JSON.stringify([...resolvedDeps].sort())) {
          throw new Error(`Idempotent replacement ${actual.taskId} already started with a different dependency contract.`);
        }
      }

      const supersededSet = new Set(supersedeIds);
      const rewired = new Set<string>();
      for (const child of children) {
        if (supersededSet.has(child.taskId)) continue;
        const deps = this.listDependencies(child.taskId).map((item) => item.dependsOnTaskId);
        if (!deps.some((id) => supersededSet.has(id))) continue;
        const nextDeps = [...deps.filter((id) => !supersededSet.has(id)), ...created.map((task) => task.taskId)];
        this.setDependenciesInTransaction(child.taskId, [...new Set(nextDeps)], now);
        rewired.add(child.taskId);
      }
      // Any new replacement which depends on a replaced task is invalid, and
      // the final verifier must wait for every replacement as well as retained work.
      if (finalVerifier && !supersededSet.has(finalVerifier.taskId)) {
        const currentDeps = this.listDependencies(finalVerifier.taskId).map((item) => item.dependsOnTaskId);
        const nextDeps = [...currentDeps.filter((id) => !supersededSet.has(id)), ...created.map((task) => task.taskId)];
        this.setDependenciesInTransaction(finalVerifier.taskId, [...new Set(nextDeps)], now);
        rewired.add(finalVerifier.taskId);
        // A verifier may itself have blocked after returning invalid/incomplete
        // acceptance evidence. A revised plan must give it one fresh run after
        // the new repair dependencies settle. Dependency gates still prevent
        // it from starting early; uncertain external actions remain a hard stop.
        if (finalVerifier.status === "blocked") {
          const unsettledVerifierActions = this.listUnsettledActions(finalVerifier.taskId);
          if (unsettledVerifierActions.length) {
            throw new Error(`Goal verifier ${finalVerifier.taskId} has unsettled external actions and cannot be safely requeued.`);
          }
          this.writeSystemTransition(finalVerifier.taskId, "queued", "goal plan revised; final verifier will re-run after revised dependencies complete", now);
        }
      }
      for (const task of superseded) {
        this.writeSystemTransition(task.taskId, "superseded", "replaced by an explicitly revised goal plan", now);
      }
      this.reconcileHierarchyInTransaction(now);
      return {
        parent: this.get(parentTaskId)!,
        superseded: superseded.map((task) => this.get(task.taskId)!),
        replacements: created.map((task) => this.get(task.taskId)!),
      };
    });
    return execute.immediate();
  }

  setDependencies(taskId: string, dependsOnTaskIds: string[], now = this.now()): void {
    const update = this.db.transaction(() => this.setDependenciesInTransaction(taskId, dependsOnTaskIds, now));
    update.immediate();
  }

  private setDependenciesInTransaction(taskId: string, dependsOnTaskIds: string[], now: string): void {
    const task = this.get(taskId);
    if (!task) throw new Error(`Cannot add dependencies to missing task ${taskId}.`);
    if (!["queued", "blocked"].includes(task.status)) throw new Error(`Dependencies cannot be changed after task ${taskId} has started.`);
    const unique = [...new Set(dependsOnTaskIds.map((id) => String(id).trim()).filter(Boolean))];
    if (unique.length !== dependsOnTaskIds.length) throw new Error("Task dependencies must contain unique, non-empty task IDs.");
    this.db.prepare("DELETE FROM miki_task_dependencies WHERE task_id=?").run(taskId);
    for (const dependencyId of unique) {
      if (dependencyId === taskId) throw new Error("A task cannot depend on itself.");
      const dependency = this.get(dependencyId);
      if (!dependency) throw new Error(`Task dependency does not exist: ${dependencyId}`);
      if (this.db.prepare("SELECT 1 FROM miki_tasks WHERE parent_task_id=? LIMIT 1").get(dependencyId)) {
        throw new Error(`A goal container cannot be used as a task dependency: ${dependencyId}`);
      }
      if (this.hasDependencyPath(dependencyId, taskId)) {
        throw new Error(`Task dependency would create a cycle: ${taskId} -> ${dependencyId}.`);
      }
      this.db.prepare("INSERT INTO miki_task_dependencies(task_id,depends_on_task_id,created_at) VALUES(?,?,?)")
        .run(taskId, dependencyId, now);
    }
  }

  private hasDependencyPath(startTaskId: string, targetTaskId: string): boolean {
    const visited = new Set<string>();
    const pending = [startTaskId];
    while (pending.length) {
      const current = pending.pop()!;
      if (current === targetTaskId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const rows = this.db.prepare("SELECT depends_on_task_id FROM miki_task_dependencies WHERE task_id=?")
        .all(current) as Array<{ depends_on_task_id: string }>;
      for (const row of rows) pending.push(row.depends_on_task_id);
    }
    return false;
  }

  listDependencies(taskId: string): TaskDependency[] {
    const rows = this.db.prepare(`SELECT d.task_id,d.depends_on_task_id,t.status
      FROM miki_task_dependencies d JOIN miki_tasks t ON t.task_id=d.depends_on_task_id
      WHERE d.task_id=? ORDER BY d.created_at,d.rowid`).all(taskId) as Array<{
        task_id: string; depends_on_task_id: string; status: TaskStatus;
      }>;
    return rows.map((row) => ({ taskId: row.task_id, dependsOnTaskId: row.depends_on_task_id, status: row.status }));
  }

  getTaskTree(taskId: string): TaskTreeNode | null {
    const root = this.get(taskId);
    if (!root) return null;
    const visited = new Set<string>();
    const build = (task: DurableTask): TaskTreeNode => {
      if (visited.has(task.taskId)) return { task, dependencies: this.listDependencies(task.taskId), children: [] };
      visited.add(task.taskId);
      const rows = this.db.prepare("SELECT * FROM miki_tasks WHERE parent_task_id=? ORDER BY priority DESC,created_at ASC")
        .all(task.taskId) as TaskRow[];
      return {
        task,
        dependencies: this.listDependencies(task.taskId),
        children: rows.map((row) => build(this.toTask(row))),
      };
    };
    return build(root);
  }

  /** Resolve a goal-level verifier after all child tasks have completed. */
  resolveVerification(taskId: string, input: {
    passed: boolean;
    evidence?: Record<string, unknown>;
    reason?: string;
    now?: string;
  }): DurableTask {
    const timestamp = input.now ?? this.now();
    const json = input.evidence === undefined ? null : JSON.stringify(input.evidence);
    if (json && Buffer.byteLength(json, "utf8") > MAX_TASK_CHECKPOINT_BYTES) throw new Error("Verification evidence is too large.");
    const update = this.db.transaction(() => {
      const task = this.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.status !== "verifying") throw new Error(`Task ${taskId} is not awaiting verification.`);
      const nextStatus: TaskStatus = input.passed ? "completed" : "needs_reconciliation";
      const next = this.transition(taskId, nextStatus, {
        now: timestamp,
        reason: input.reason ?? (input.passed ? "goal acceptance verification passed" : "goal acceptance verification failed"),
        result: task.result,
        verificationResult: { passed: input.passed, ...(input.evidence ? { evidence: input.evidence } : {}) },
      });
      return next;
    });
    return update.immediate();
  }

  /**
   * Reconciles dependency gates and parent goal summaries. Safe to call at worker
   * startup, after a task transition, or from a supervisor recovery tick.
   */
  reconcileHierarchy(now = this.now()): { blockedDependents: number; updatedParents: number } {
    const reconcile = this.db.transaction(() => this.reconcileHierarchyInTransaction(now));
    return reconcile.immediate();
  }

  private reconcileHierarchyInTransaction(now: string): { blockedDependents: number; updatedParents: number } {
    let blockedDependents = 0;
    let updatedParents = 0;
    // A dependency_blocked task is itself only waiting; do not cascade that
    // waiting state through every downstream node. The claim gate still prevents
    // any descendant from running until its direct prerequisites complete.
    const dependents = this.db.prepare(`SELECT DISTINCT t.* FROM miki_tasks t
      JOIN miki_task_dependencies d ON d.task_id=t.task_id
      JOIN miki_tasks dep ON dep.task_id=d.depends_on_task_id
      WHERE t.status IN ('queued','retrying') AND (dep.status IN ('failed','cancelled','needs_reconciliation') OR (dep.status='blocked' AND COALESCE(dep.error_category,'')!='dependency_blocked'))
      ORDER BY t.created_at ASC`).all() as TaskRow[];
    for (const row of dependents) {
      const failedDependency = this.db.prepare(`SELECT dep.task_id,dep.status FROM miki_task_dependencies d
        JOIN miki_tasks dep ON dep.task_id=d.depends_on_task_id
        WHERE d.task_id=? AND (dep.status IN ('failed','cancelled','needs_reconciliation') OR (dep.status='blocked' AND COALESCE(dep.error_category,'')!='dependency_blocked'))
        ORDER BY dep.updated_at DESC LIMIT 1`).get(row.task_id) as { task_id: string; status: TaskStatus } | undefined;
      this.writeSystemTransition(
        row.task_id,
        "blocked",
        `dependency ${failedDependency?.task_id ?? "unknown"} is ${failedDependency?.status ?? "not complete"}`,
        now,
        undefined,
        "dependency_blocked",
      );
      blockedDependents += 1;
    }

    // Dependency-blocked work becomes runnable automatically once every
    // prerequisite is completed. Other blocked tasks still require owner action.
    const unblocked = this.db.prepare(`SELECT t.task_id FROM miki_tasks t
      WHERE t.status='blocked' AND t.error_category='dependency_blocked'
        AND NOT EXISTS (
          SELECT 1 FROM miki_task_dependencies d JOIN miki_tasks dep ON dep.task_id=d.depends_on_task_id
          WHERE d.task_id=t.task_id AND dep.status NOT IN ('completed','superseded')
        ) ORDER BY t.created_at ASC`).all() as Array<{ task_id: string }>;
    for (const row of unblocked) {
      this.writeSystemTransition(row.task_id, "queued", "all task dependencies are now completed; task unblocked", now);
    }

    const parents = this.db.prepare(`SELECT DISTINCT p.* FROM miki_tasks p
      JOIN miki_tasks c ON c.parent_task_id=p.task_id ORDER BY p.created_at ASC`).all() as TaskRow[];
    for (const parentRow of parents) {
      const parent = this.toTask(parentRow);
      if (isTerminalTaskStatus(parent.status)) continue;
      const children = this.db.prepare("SELECT task_id,status,progress,verification_result_json FROM miki_tasks WHERE parent_task_id=? ORDER BY created_at ASC")
        .all(parent.taskId) as Array<{ task_id: string; status: TaskStatus; progress: number | null; verification_result_json: string | null }>;
      if (!children.length) continue;
      const count = children.length;
      const progress = Math.floor(children.reduce((sum, child) => sum + (["completed", "superseded"].includes(child.status) ? 100 : child.progress ?? 0), 0) / count);
      const allCompleted = children.every((child) => ["completed", "superseded"].includes(child.status));
      const allCancelled = children.every((child) => child.status === "cancelled");
      const hasCancelled = children.some((child) => child.status === "cancelled");
      const hasReconciliation = children.some((child) => child.status === "needs_reconciliation");
      const hasBlocked = children.some((child) => ["blocked", "failed"].includes(child.status));
      const hasActive = children.some((child) => ["running", "retrying", "verifying", "completed", "waiting_approval"].includes(child.status));
      const parentCancellationSettled = Boolean(parent.cancelRequestedAt) && children.every((child) => isTerminalTaskStatus(child.status));
      const verifierTaskId = typeof parent.verificationSpec?.finalVerifierTaskId === "string"
        ? parent.verificationSpec.finalVerifierTaskId
        : undefined;
      const verifierTask = verifierTaskId ? children.find((child) => child.task_id === verifierTaskId) : undefined;
      let verifierEvidence: Record<string, unknown> | undefined;
      try {
        if (verifierTask?.verification_result_json) {
          const parsed = JSON.parse(verifierTask.verification_result_json) as Record<string, unknown>;
          if (parsed.passed === true) verifierEvidence = parsed;
        }
      } catch { verifierEvidence = undefined; }
      const verifierPassed = parent.verificationSpec?.kind === "goal_verifier_child"
        && verifierTask?.status === "completed" && Boolean(verifierEvidence);
      const requiresGoalVerifier = parent.verificationSpec?.kind === "goal_verifier_child";
      const target: TaskStatus = parentCancellationSettled
        ? "cancelled"
        : hasReconciliation
          ? "needs_reconciliation"
        : hasBlocked
          ? "blocked"
          : allCancelled
            ? "cancelled"
            : hasCancelled
              ? "blocked"
              : allCompleted
                ? requiresGoalVerifier ? verifierPassed ? "completed" : "verifying" : "completed"
                : hasActive
                  ? "running"
                  : "queued";
      this.db.prepare("UPDATE miki_tasks SET progress=?,updated_at=? WHERE task_id=?")
        .run(target === "completed" ? 100 : allCompleted ? 95 : progress, now, parent.taskId);
      if (target === parent.status) continue;
      if (["verifying", "completed"].includes(target) && parent.status !== "running" && parent.status !== "verifying") {
        if (["queued", "blocked", "needs_reconciliation"].includes(parent.status)) {
          this.writeSystemTransition(parent.taskId, "running", "all child tasks finished; starting goal verification", now);
        }
      }
      let current = this.get(parent.taskId);
      if (target === "completed" && current?.status === "running") {
        this.writeSystemTransition(parent.taskId, "verifying", "designated goal-verifier child passed", now);
        current = this.get(parent.taskId);
      }
      if (current && current.status !== target) {
        const can = this.canSystemTransition(current.status, target);
        if (can) {
          this.writeSystemTransition(parent.taskId, target, `child task aggregate changed to ${target}`, now,
            target === "completed"
              ? verifierEvidence
                ? { passed: true, verifierEvidence, verifierTaskId }
                : { passed: true, method: "all_child_tasks_completed", childTaskIds: children.map((child) => child.task_id) }
              : undefined);
          updatedParents += 1;
        }
      }
    }
    return { blockedDependents, updatedParents };
  }

  private canSystemTransition(from: TaskStatus, to: TaskStatus): boolean {
    try {
      transitionTask({ taskId: "system", status: from, version: 0, updatedAt: "" }, to);
      return true;
    } catch { return false; }
  }

  private writeSystemTransition(
    taskId: string,
    status: TaskStatus,
    reason: string,
    now: string,
    verificationResult?: Record<string, unknown>,
    errorCategory?: string,
  ): void {
    const current = this.get(taskId);
    if (!current || current.status === status || !this.canSystemTransition(current.status, status)) return;
    const next = transitionTask(current, status, { now, reason });
    const verificationJson = verificationResult === undefined ? null : JSON.stringify(verificationResult);
    this.db.prepare(`UPDATE miki_tasks SET status=?,version=?,last_error=?,lease_expires_at=NULL,
      lease_token=NULL,worker_id=NULL,next_retry_at=NULL,
      verification_result_json=COALESCE(?,verification_result_json),
      error_category=CASE WHEN ? IN ('queued','completed','cancelled','superseded') THEN NULL ELSE COALESCE(?,error_category) END,
      cancel_requested_at=CASE WHEN ? IN ('completed','failed','cancelled','superseded') THEN NULL ELSE cancel_requested_at END,
      updated_at=? WHERE task_id=? AND version=?`)
      .run(next.status, next.version, ["blocked", "needs_reconciliation"].includes(status) ? reason : null,
        verificationJson, status, errorCategory ?? null, status, now, taskId, current.version);
    this.db.prepare(`INSERT INTO miki_task_events(task_id,from_status,to_status,version,reason,created_at)
      VALUES(?,?,?,?,?,?)`).run(taskId, current.status, status, next.version, reason, now);
  }

  /** Parent cancellation is propagated recursively; running workers observe the durable flag. */
  requestCancel(taskId: string, now = this.now()): { accepted: boolean; status?: TaskStatus; affected: number } {
    const cancel = this.db.transaction(() => {
      const root = this.get(taskId);
      if (!root) return { accepted: false, affected: 0 };
      if (isTerminalTaskStatus(root.status)) return { accepted: root.status === "cancelled", status: root.status, affected: 0 };
      const descendants = this.db.prepare(`WITH RECURSIVE tree(task_id) AS (
        SELECT task_id FROM miki_tasks WHERE task_id=?
        UNION
        SELECT child.task_id FROM miki_tasks child JOIN tree parent ON child.parent_task_id=parent.task_id
      ) SELECT t.* FROM miki_tasks t JOIN tree ON tree.task_id=t.task_id`).all(taskId) as TaskRow[];
      const hasActiveDescendant = descendants.some((row) => row.task_id !== taskId && ["running", "verifying"].includes(row.status));
      let affected = 0;
      for (const row of descendants) {
        const current = this.toTask(row);
        if (isTerminalTaskStatus(current.status)) continue;
        if (["running", "verifying"].includes(current.status) || (current.taskId === taskId && hasActiveDescendant)) {
          // Keep a parent non-terminal until every active descendant has actually
          // observed cancellation and settled; otherwise the goal would display
          // cancelled while a child was still performing external work.
          const changed = this.db.prepare(`UPDATE miki_tasks SET cancel_requested_at=COALESCE(cancel_requested_at,?),updated_at=?
            WHERE task_id=? AND status IN ('queued','running','verifying','retrying','waiting_approval','blocked','needs_reconciliation')`).run(now, now, current.taskId);
          affected += changed.changes;
        } else {
          this.writeSystemTransition(current.taskId, "cancelled", "cancelled by owner; parent cancellation propagated", now);
          affected += 1;
        }
      }
      this.reconcileHierarchyInTransaction(now);
      return { accepted: affected > 0, status: this.get(taskId)?.status, affected };
    });
    return cancel.immediate();
  }

  /** Move a blocked/uncertain task back to queued only after its owner supplies reconciliation evidence. */
  resumeAfterReconciliation(taskId: string, evidence: Record<string, unknown>, now = this.now()): DurableTask {
    const task = this.get(taskId);
    if (!task || !["blocked", "needs_reconciliation", "waiting_approval", "failed"].includes(task.status)) {
      throw new Error(`Task ${taskId} is not awaiting reconciliation or owner-approved retry.`);
    }
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || Object.keys(evidence).length === 0) {
      throw new Error("Non-empty reconciliation evidence is required before resuming a blocked task.");
    }
    const evidenceJson = JSON.stringify(evidence);
    if (Buffer.byteLength(evidenceJson, "utf8") > MAX_TASK_CHECKPOINT_BYTES) throw new Error("Reconciliation evidence exceeds the configured size limit.");
    if (task.errorCategory === "dependency_blocked") {
      const pending = this.db.prepare(`SELECT COUNT(*) AS count FROM miki_task_dependencies d
        JOIN miki_tasks dep ON dep.task_id=d.depends_on_task_id
        WHERE d.task_id=? AND dep.status NOT IN ('completed','superseded')`).get(taskId) as { count: number };
      if (pending.count > 0) throw new Error("Task cannot resume until all dependencies are completed.");
    }
    const unsettled = this.listUnsettledActions(taskId);
    if (unsettled.length > 0) {
      throw new Error(`Cannot resume while ${unsettled.length} external action(s) remain unsettled. Reconcile each action first.`);
    }
    return this.transition(taskId, "queued", {
      now,
      reason: "owner reconciled task state and authorized resumption",
      verificationResult: { ...(task.verificationResult ?? {}), reconciled: true, reconciliationEvidence: evidence },
      errorCategory: undefined,
    });
  }

  get(taskId: string): DurableTask | null {
    const row = this.db.prepare("SELECT * FROM miki_tasks WHERE task_id=?").get(taskId) as TaskRow | undefined;
    return row ? this.toTask(row) : null;
  }

  listRecent(options: { taskType?: string; taskTypes?: string[]; sessionId?: string; limit?: number } = {}): DurableTask[] {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(100, Math.trunc(options.limit!))) : 25;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.taskType) { clauses.push("task_type=?"); params.push(options.taskType); }
    else if (options.taskTypes?.length) {
      const taskTypes = [...new Set(options.taskTypes.map((value) => value.trim()).filter(Boolean))];
      if (taskTypes.length) { clauses.push(`task_type IN (${taskTypes.map(() => "?").join(",")})`); params.push(...taskTypes); }
    }
    if (options.sessionId) { clauses.push("session_id=?"); params.push(options.sessionId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM miki_tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit) as TaskRow[];
    return rows.map((row) => this.toTask(row));
  }

  listChildren(parentTaskId: string): DurableTask[] {
    const rows = this.db.prepare(`SELECT * FROM miki_tasks WHERE parent_task_id=?
      ORDER BY priority DESC,created_at ASC`).all(parentTaskId) as TaskRow[];
    return rows.map((row) => this.toTask(row));
  }

  /** Keep the durable queue bounded without deleting in-flight or retryable work. */
  pruneTerminal(options: { now?: string; taskType?: string; retentionMs?: number; maxRecords?: number } = {}): number {
    const timestamp = options.now ?? this.now();
    const retentionMs = Number.isFinite(options.retentionMs) ? Math.max(60 * 60 * 1_000, Math.floor(options.retentionMs!)) : 30 * 24 * 60 * 60 * 1_000;
    const maxRecords = Number.isFinite(options.maxRecords) ? Math.max(1, Math.min(10_000, Math.floor(options.maxRecords!))) : 2_000;
    const cutoff = new Date(Date.parse(timestamp) - retentionMs).toISOString();
    const typeClause = options.taskType ? " AND task_type=?" : "";
    const typeArgs = options.taskType ? [options.taskType] : [];
    const retainClause = `
      AND NOT EXISTS (
        SELECT 1 FROM miki_task_dependencies d JOIN miki_tasks dependent ON dependent.task_id=d.task_id
        WHERE d.depends_on_task_id=miki_tasks.task_id AND dependent.status NOT IN ('completed','failed','cancelled','superseded')
      )
      AND NOT EXISTS (
        SELECT 1 FROM miki_tasks child WHERE child.parent_task_id=miki_tasks.task_id
          AND child.status NOT IN ('completed','failed','cancelled','superseded')
      )
      AND (parent_task_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM miki_tasks parent WHERE parent.task_id=miki_tasks.parent_task_id
          AND parent.status NOT IN ('completed','failed','cancelled','superseded')
      ))`;
    const prune = this.db.transaction(() => {
      const oldRows = this.db.prepare(`
        SELECT task_id FROM miki_tasks
        WHERE status IN ('completed','failed','cancelled','superseded') AND updated_at<?${typeClause}${retainClause}
        LIMIT 500
      `).all(cutoff, ...typeArgs) as Array<{ task_id: string }>;
      const excessRows = this.db.prepare(`
        SELECT task_id FROM miki_tasks
        WHERE status IN ('completed','failed','cancelled','superseded')${typeClause}${retainClause}
        ORDER BY updated_at DESC LIMIT 500 OFFSET ?
      `).all(...typeArgs, maxRecords) as Array<{ task_id: string }>;
      const ids = [...new Set([...oldRows, ...excessRows].map((row) => row.task_id))];
      if (!ids.length) return 0;
      let deleted = 0;
      for (let index = 0; index < ids.length; index += 500) {
        const batch = ids.slice(index, index + 500);
        const placeholders = batch.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM miki_background_job_actions WHERE task_id IN (${placeholders})`).run(...batch);
        this.db.prepare(`DELETE FROM miki_task_events WHERE task_id IN (${placeholders})`).run(...batch);
        deleted += this.db.prepare(`DELETE FROM miki_tasks WHERE task_id IN (${placeholders})`).run(...batch).changes;
      }
      return deleted;
    });
    return prune();
  }

  listEvents(taskId: string): TaskTransitionEvent[] {
    const rows = this.db.prepare("SELECT * FROM miki_task_events WHERE task_id=? ORDER BY id ASC").all(taskId) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      version: row.version,
      ...(row.reason ? { reason: row.reason } : {}),
      createdAt: row.created_at,
    }));
  }

  transition(
    taskId: string,
    nextStatus: TaskStatus,
    options: {
      now?: string; reason?: string; leaseMs?: number; leaseToken?: string; result?: string;
      error?: string; errorCategory?: string; nextRetryAt?: string | null;
      verificationResult?: Record<string, unknown>;
    } = {},
  ): DurableTask {
    const update = this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error(`Task not found: ${taskId}`);
      const timestamp = options.now ?? this.now();
      const next = transitionTask(current, nextStatus, {
        now: timestamp,
        ...(options.reason ? { reason: options.reason } : {}),
      });
      if (options.leaseToken && current.leaseToken !== options.leaseToken) throw new Error(`Task lease was lost: ${taskId}`);
      if (options.leaseToken && (!current.leaseExpiresAt || current.leaseExpiresAt <= timestamp)) throw new Error(`Task lease expired before commit: ${taskId}`);
      const leaseExpiresAt = next.status === "running" && options.leaseMs !== undefined
        ? new Date(Date.parse(timestamp) + Math.max(0, options.leaseMs)).toISOString()
        : next.status === "verifying" ? current.leaseExpiresAt ?? null : null;
      const keepLease = next.status === "running" || next.status === "verifying";
      const nextRetryAt = next.status === "retrying" ? options.nextRetryAt ?? null : null;
      const verificationJson = options.verificationResult === undefined ? null : JSON.stringify(options.verificationResult);
      if (verificationJson && Buffer.byteLength(verificationJson, "utf8") > MAX_TASK_CHECKPOINT_BYTES) throw new Error("Verification result exceeds the configured size limit.");
      const result = this.db.prepare(`
        UPDATE miki_tasks
        SET status=?,version=?,lease_expires_at=?,lease_token=?,worker_id=?,last_error=?,result=?,next_retry_at=?,error_category=?,
          verification_result_json=COALESCE(?,verification_result_json),
          cancel_requested_at=CASE WHEN ? IN ('completed','failed','cancelled','superseded') THEN NULL ELSE cancel_requested_at END,updated_at=?
        WHERE task_id=? AND version=? AND (? IS NULL OR lease_token=?)
      `).run(
        next.status,
        next.version,
        leaseExpiresAt,
        keepLease ? current.leaseToken ?? null : null,
        keepLease ? current.workerId ?? null : null,
        options.error ?? (next.status === "failed" ? (next.reason ?? null) : (["queued", "running", "completed", "cancelled"].includes(next.status) ? null : current.lastError ?? null)),
        options.result ?? current.result ?? null,
        nextRetryAt,
        options.errorCategory !== undefined
          ? options.errorCategory
          : ["queued", "completed", "cancelled"].includes(next.status) ? null : current.errorCategory ?? null,
        verificationJson,
        next.status,
        timestamp,
        taskId,
        current.version,
        options.leaseToken ?? null,
        options.leaseToken ?? null,
      );
      if (result.changes !== 1) throw new Error(`Task version or lease conflict: ${taskId}`);
      this.db.prepare(`
        INSERT INTO miki_task_events(task_id,from_status,to_status,version,reason,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(taskId, current.status, next.status, next.version, next.reason ?? null, timestamp);
      this.reconcileHierarchyInTransaction(timestamp);
      return this.get(taskId)!;
    });
    return update.immediate();
  }

  claimNext(now = this.now(), leaseMs = 60_000, options: { taskType?: string; workerId?: string } = {}): DurableTask | null {
    const claim = this.db.transaction(() => {
      const taskType = options.taskType ?? "tracked_run";
      const row = this.db.prepare(`
        SELECT * FROM miki_tasks
        WHERE task_type=? AND (status='queued' OR (status='retrying' AND (next_retry_at IS NULL OR next_retry_at<=?)))
          AND NOT EXISTS (
            SELECT 1 FROM miki_task_dependencies d
            JOIN miki_tasks dep ON dep.task_id=d.depends_on_task_id
            WHERE d.task_id=miki_tasks.task_id AND dep.status NOT IN ('completed','superseded')
          )
          AND NOT EXISTS (SELECT 1 FROM miki_tasks child WHERE child.parent_task_id=miki_tasks.task_id)
        ORDER BY (priority + MAX(0,CAST((julianday(?) - julianday(created_at))*144 AS INTEGER))) DESC,
          CASE WHEN status='queued' THEN 0 ELSE 1 END, created_at ASC
        LIMIT 1
      `).get(taskType, now, now) as TaskRow | undefined;
      if (!row) return null;
      const current = this.toTask(row);
      const next = transitionTask(current, "running", { now, reason: "worker claimed task" });
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(Date.parse(now) + Math.max(0, leaseMs)).toISOString();
      const updated = this.db.prepare(`
        UPDATE miki_tasks
        SET status='running',version=?,lease_expires_at=?,lease_token=?,worker_id=?,attempt_count=attempt_count+1,next_retry_at=NULL,updated_at=?
        WHERE task_id=? AND version=? AND status=?
      `).run(next.version, leaseExpiresAt, leaseToken, options.workerId ?? null, now, row.task_id, current.version, current.status);
      if (updated.changes !== 1) return null;
      this.db.prepare(`
        INSERT INTO miki_task_events(task_id,from_status,to_status,version,reason,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(row.task_id, current.status, "running", next.version, "worker claimed task", now);
      return this.get(row.task_id);
    });
    return claim.immediate();
  }

  renewLease(taskId: string, now = this.now(), leaseMs = 60_000, leaseToken?: string): boolean {
    const leaseExpiresAt = new Date(Date.parse(now) + Math.max(0, leaseMs)).toISOString();
    return this.db.prepare(`
      UPDATE miki_tasks SET lease_expires_at=?,updated_at=?
      WHERE task_id=? AND status IN ('running','verifying') AND lease_expires_at>? AND (? IS NULL OR lease_token=?)
    `).run(leaseExpiresAt, now, taskId, now, leaseToken ?? null, leaseToken ?? null).changes === 1;
  }

  updateProgress(taskId: string, input: { progress?: number; checkpoint?: Record<string, unknown>; now?: string; leaseToken?: string }): boolean {
    const timestamp = input.now ?? this.now();
    if (input.progress !== undefined && !Number.isFinite(input.progress)) throw new Error("Task progress must be a finite number.");
    const progress = input.progress === undefined ? null : Math.max(0, Math.min(100, Math.floor(input.progress)));
    const checkpointJson = input.checkpoint === undefined ? null : JSON.stringify(input.checkpoint);
    if (checkpointJson && Buffer.byteLength(checkpointJson, "utf8") > MAX_TASK_CHECKPOINT_BYTES) throw new Error(`Task checkpoint exceeds ${MAX_TASK_CHECKPOINT_BYTES} bytes.`);
    return this.db.prepare(`
      UPDATE miki_tasks
      SET progress=COALESCE(?,progress),checkpoint_json=COALESCE(?,checkpoint_json),updated_at=?
      WHERE task_id=? AND status='running' AND cancel_requested_at IS NULL AND lease_expires_at>? AND (? IS NULL OR lease_token=?)
    `).run(progress, checkpointJson, timestamp, taskId, timestamp, input.leaseToken ?? null, input.leaseToken ?? null).changes === 1;
  }

  releaseClaim(taskId: string, leaseToken: string, now = this.now(), reason = "worker stopping; task safely requeued"): DurableTask {
    const release = this.db.transaction(() => {
      this.transition(taskId, "retrying", { now, reason, nextRetryAt: now, leaseToken });
      this.db.prepare("UPDATE miki_tasks SET attempt_count=MAX(0,attempt_count-1),cancel_requested_at=NULL WHERE task_id=?").run(taskId);
      return this.get(taskId)!;
    });
    return release();
  }

  recoverExpired(now = this.now(), options: { taskType?: string } = {}): DurableTask[] {
    const clauses = ["status IN ('running','verifying')", "lease_expires_at IS NOT NULL", "lease_expires_at<=?"];
    const params: string[] = [now];
    if (options.taskType) { clauses.push("task_type=?"); params.push(options.taskType); }
    const recover = this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT task_id,attempt_count,max_attempts,cancel_requested_at,version,lease_token
        FROM miki_tasks WHERE ${clauses.join(" AND ")} ORDER BY updated_at ASC`).all(...params) as Array<{
          task_id: string; attempt_count: number; max_attempts: number; cancel_requested_at: string | null;
          version: number; lease_token: string | null;
        }>;
      const recovered: DurableTask[] = [];
      for (const row of rows) {
        // Re-read and fence every row inside the same IMMEDIATE transaction. A
        // second recovery process will observe the state change and skip it.
        const current = this.get(row.task_id);
        if (!current || !["running", "verifying"].includes(current.status) || !current.leaseExpiresAt || current.leaseExpiresAt > now || current.version !== row.version) continue;
        if (current.cancelRequestedAt) {
          recovered.push(this.transition(row.task_id, "cancelled", {
            now, reason: "cancelled while the worker was unavailable",
          }));
          continue;
        }
        const unsettled = this.db.prepare(`SELECT COUNT(*) AS count FROM miki_background_job_actions
          WHERE task_id=? AND status IN ('running','failed')`).get(row.task_id) as { count: number };
        if (Number(unsettled.count) > 0) {
          recovered.push(this.transition(row.task_id, "needs_reconciliation", {
            now,
            reason: "worker lease expired while an external action had no confirmed outcome",
            error: "External side effects may have completed; inspect action ledger and reconcile before retrying.",
            errorCategory: "uncertain_side_effect",
          }));
          continue;
        }
        const attemptsExhausted = row.max_attempts > 0 && row.attempt_count >= row.max_attempts;
        if (attemptsExhausted) {
          recovered.push(this.transition(row.task_id, "failed", {
            now,
            reason: `worker lease expired after the maximum number of attempts (${row.attempt_count}/${row.max_attempts})`,
            errorCategory: "transient",
          }));
        } else {
          recovered.push(this.transition(row.task_id, "retrying", {
            now,
            reason: current.status === "verifying"
              ? "verification lease expired; verification will be safely retried"
              : "worker lease expired; task requeued",
            nextRetryAt: now,
            errorCategory: "transient",
          }));
        }
      }
      return recovered;
    });
    return recover.immediate();
  }

  claimAction(taskId: string, actionKey: string, toolName: string, leaseToken: string): DurableActionClaim {
    if (!leaseToken) return { status: "lease_lost" };
    const now = this.now();
    const claim = this.db.transaction(() => {
      const owner = this.db.prepare("SELECT status,lease_token,lease_expires_at,cancel_requested_at FROM miki_tasks WHERE task_id=?").get(taskId) as { status: string; lease_token: string | null; lease_expires_at: string | null; cancel_requested_at: string | null } | undefined;
      if (!owner || owner.status !== "running" || owner.lease_token !== leaseToken || !owner.lease_expires_at || owner.lease_expires_at <= now || owner.cancel_requested_at) return { status: "lease_lost" as const };
      const existing = this.db.prepare("SELECT status,result_json,error_text FROM miki_background_job_actions WHERE task_id=? AND action_key=?").get(taskId, actionKey) as { status: string; result_json: string | null; error_text: string | null } | undefined;
      if (existing) {
        if (existing.status === "completed") return { status: "completed" as const, result: existing.result_json ? JSON.parse(existing.result_json) : null };
        return { status: "needs_reconciliation" as const, ...(existing.error_text ? { error: existing.error_text } : {}) };
      }
      this.db.prepare("INSERT INTO miki_background_job_actions(task_id,action_key,tool_name,status,created_at,updated_at) VALUES(?,?,?,'running',?,?)").run(taskId, actionKey, toolName, now, now);
      return { status: "execute" as const };
    });
    return claim();
  }

  listUnsettledActions(taskId: string): Array<{ actionKey: string; toolName: string; status: "running" | "failed"; error?: string }> {
    const rows = this.db.prepare("SELECT action_key,tool_name,status,error_text FROM miki_background_job_actions WHERE task_id=? AND status!='completed' ORDER BY created_at ASC").all(taskId) as Array<{ action_key: string; tool_name: string; status: string; error_text: string | null }>
    return rows.map((row) => ({
      actionKey: row.action_key,
      toolName: row.tool_name,
      status: row.status === "running" ? "running" as const : "failed" as const,
      ...(row.error_text ? { error: row.error_text } : {}),
    }))
  }

  /** Owner-confirmed resolution of an uncertain external action. */
  reconcileAction(taskId: string, actionKey: string, input: {
    outcome: "completed" | "not_applied";
    evidence: Record<string, unknown>;
    result?: unknown;
    now?: string;
  }): void {
    const timestamp = input.now ?? this.now();
    const task = this.get(taskId);
    if (!task || task.status !== "needs_reconciliation") throw new Error("Only tasks awaiting external reconciliation can resolve action records.");
    if (!input.evidence || typeof input.evidence !== "object" || Array.isArray(input.evidence) || Object.keys(input.evidence).length === 0) {
      throw new Error("Non-empty external-state evidence is required to reconcile an action.");
    }
    const jsonEvidence = JSON.stringify(input.evidence);
    if (Buffer.byteLength(jsonEvidence, "utf8") > MAX_TASK_CHECKPOINT_BYTES) throw new Error("Action reconciliation evidence is too large.");
    const resultJson = JSON.stringify(input.result ?? null);
    if (Buffer.byteLength(resultJson, "utf8") > MAX_ACTION_RESULT_BYTES) throw new Error("Reconciled action result is too large.");
    const update = this.db.transaction(() => {
      const row = this.db.prepare("SELECT status FROM miki_background_job_actions WHERE task_id=? AND action_key=?")
        .get(taskId, actionKey) as { status: string } | undefined;
      if (!row || !["running", "failed"].includes(row.status)) throw new Error("Unsettled action record was not found.");
      if (input.outcome === "completed") {
        this.db.prepare(`UPDATE miki_background_job_actions SET status='completed',result_json=?,error_text=NULL,updated_at=?
          WHERE task_id=? AND action_key=?`).run(resultJson, timestamp, taskId, actionKey);
      } else {
        // Removing the uncertain record permits the same deterministic action key
        // to be claimed again; the evidence is retained on the task itself.
        this.db.prepare("DELETE FROM miki_background_job_actions WHERE task_id=? AND action_key=?").run(taskId, actionKey);
      }
      const latest = this.get(taskId)!;
      const currentEvidence = latest.verificationResult ?? {};
      const priorActions = Array.isArray(currentEvidence.actions) ? currentEvidence.actions : [];
      const nextEvidence = {
        ...currentEvidence,
        actions: [...priorActions, { actionKey, outcome: input.outcome, evidence: input.evidence, reconciledAt: timestamp }],
      };
      const json = JSON.stringify(nextEvidence);
      if (Buffer.byteLength(json, "utf8") > MAX_TASK_CHECKPOINT_BYTES) throw new Error("Accumulated action reconciliation evidence is too large.");
      this.db.prepare("UPDATE miki_tasks SET verification_result_json=?,updated_at=? WHERE task_id=?")
        .run(json, timestamp, taskId);
    });
    update.immediate();
  }

  completeAction(taskId: string, actionKey: string, result: unknown, leaseToken: string): void {
    const json = JSON.stringify(result ?? null);
    if (Buffer.byteLength(json, "utf8") > MAX_ACTION_RESULT_BYTES) throw new Error(`Background action result exceeds ${MAX_ACTION_RESULT_BYTES} bytes; manual reconciliation is required.`);
    const timestamp = this.now();
    const changed = this.db.prepare(`
      UPDATE miki_background_job_actions
      SET status='completed',result_json=?,updated_at=?
      WHERE task_id=? AND action_key=? AND status='running'
        AND EXISTS (
          SELECT 1 FROM miki_tasks t
          WHERE t.task_id=? AND t.status='running' AND t.lease_token=?
            AND t.lease_expires_at>? AND t.cancel_requested_at IS NULL
        )
    `).run(json, timestamp, taskId, actionKey, taskId, leaseToken, timestamp).changes;
    if (changed !== 1) throw new Error("Task lease was lost before the external action result could be committed; reconciliation is required.");
  }

  failAction(taskId: string, actionKey: string, error: string, leaseToken: string): boolean {
    const timestamp = this.now();
    return this.db.prepare(`
      UPDATE miki_background_job_actions
      SET status='failed',error_text=?,updated_at=?
      WHERE task_id=? AND action_key=? AND status='running'
        AND EXISTS (
          SELECT 1 FROM miki_tasks t
          WHERE t.task_id=? AND t.status='running' AND t.lease_token=?
            AND t.lease_expires_at>? AND t.cancel_requested_at IS NULL
        )
    `).run(error.slice(0, 2_000), timestamp, taskId, actionKey, taskId, leaseToken, timestamp).changes === 1;
  }

  private toTask(row: TaskRow): DurableTask {
    let payload: unknown;
    let checkpoint: Record<string, unknown> | undefined;
    let verificationSpec: Record<string, unknown> | undefined;
    let verificationResult: Record<string, unknown> | undefined;
    try { if (row.payload_json) payload = JSON.parse(row.payload_json); } catch { payload = undefined; }
    try { if (row.checkpoint_json) checkpoint = JSON.parse(row.checkpoint_json) as Record<string, unknown>; } catch { checkpoint = undefined; }
    try { if (row.verification_spec_json) verificationSpec = JSON.parse(row.verification_spec_json) as Record<string, unknown>; } catch { verificationSpec = undefined; }
    try { if (row.verification_result_json) verificationResult = JSON.parse(row.verification_result_json) as Record<string, unknown>; } catch { verificationResult = undefined; }
    return {
      taskId: row.task_id,
      goal: row.goal,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      status: row.status,
      version: row.version,
      createdAt: row.created_at,
      ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
      ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
      ...(row.worker_id ? { workerId: row.worker_id } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      ...(row.result ? { result: row.result } : {}),
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
      taskType: row.task_type,
      ...(payload !== undefined ? { payload } : {}),
      ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
      ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
      ...(row.progress !== null ? { progress: row.progress } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(row.cancel_requested_at ? { cancelRequestedAt: row.cancel_requested_at } : {}),
      priority: Number(row.priority ?? 0),
      ...(verificationSpec ? { verificationSpec } : {}),
      ...(verificationResult ? { verificationResult } : {}),
      ...(row.error_category ? { errorCategory: row.error_category } : {}),
      updatedAt: row.updated_at,
    };
  }
}
