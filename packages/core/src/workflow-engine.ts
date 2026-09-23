import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import Database from "better-sqlite3";
import {
  AgentRunRecorder,
  type AgentRun,
  type VerificationEvidence,
} from "./agent-run.js";

export interface WorkflowContext {
  runId: string;
  sessionId?: string;
  signal: AbortSignal;
  /** Stable identity for the current side-effecting step across retries/resume. */
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  context?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  stepIndex: number;
  attempt: number;
}
export interface PlannedStep {
  id: string;
  title: string;
  phase?: "planner" | "executor" | "verifier";
}
export interface ExecutionResult {
  ok: boolean;
  summary: string;
  output?: Record<string, unknown>;
  retryable?: boolean;
}
export interface WorkflowPlanner {
  plan(objective: string, signal: AbortSignal): Promise<PlannedStep[]>;
}
export interface WorkflowExecutor {
  execute(
    step: PlannedStep,
    context: WorkflowContext,
  ): Promise<ExecutionResult>;
}
export interface WorkflowVerifier {
  verify(
    step: PlannedStep,
    result: ExecutionResult,
    context: WorkflowContext,
  ): Promise<VerificationEvidence>;
}

type StepState = PlannedStep & {
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  error?: string;
  output?: Record<string, unknown>;
};
export interface WorkflowState {
  id: string;
  objective: string;
  sessionId?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  steps: StepState[];
  cursor: number;
  attempts: number;
  errors: string[];
  result?: ExecutionResult;
  context?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  heartbeatAt?: string;
  leaseOwner?: string;
  leaseUntil?: number;
}
export interface WorkflowStateStore {
  get(id: string): WorkflowState | null;
  save(state: WorkflowState): void;
  listActive(): WorkflowState[];
  claim?(state: WorkflowState, owner: string, leaseMs: number): boolean;
  release?(id: string, owner: string): void;
  /** Cheap lease-only renewal (no full state rewrite). Optional: stores that
   * don't implement it fall back to a full save() for lease renewal. */
  renewLease?(id: string, owner: string, leaseMs: number): boolean;
}

export class InMemoryWorkflowStateStore implements WorkflowStateStore {
  private readonly states = new Map<string, WorkflowState>();
  get(id: string): WorkflowState | null {
    return clone(this.states.get(id));
  }
  save(state: WorkflowState): void {
    this.states.set(state.id, clone(state)!);
  }
  listActive(): WorkflowState[] {
    return [...this.states.values()]
      .filter(
        (state) => state.status === "pending" || state.status === "running",
      )
      .map((state) => clone(state)!);
  }
}

export class JsonWorkflowStateStore implements WorkflowStateStore {
  constructor(private readonly filePath: string) {}
  get(id: string): WorkflowState | null {
    return this.load().find((state) => state.id === id) ?? null;
  }
  save(state: WorkflowState): void {
    const states = this.load().filter((item) => item.id !== state.id);
    states.push(clone(state)!);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(states, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filePath);
  }
  listActive(): WorkflowState[] {
    return this.load().filter(
      (state) => state.status === "pending" || state.status === "running",
    );
  }
  private load(): WorkflowState[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(value) ? value.filter(isWorkflowState) : [];
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

/** SQLite store with an atomic lease claim for multi-process workers. */
export class SqliteWorkflowStateStore implements WorkflowStateStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_states (
        id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER
      );
      CREATE INDEX IF NOT EXISTS workflow_states_active_idx
        ON workflow_states(lease_until);
    `);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
  }

  get(id: string): WorkflowState | null {
    const row = this.db
      .prepare("SELECT state_json, lease_owner, lease_until FROM workflow_states WHERE id = ?")
      .get(id) as { state_json: string; lease_owner?: string; lease_until?: number } | undefined;
    if (!row) return null;
    const state = JSON.parse(row.state_json) as WorkflowState;
    if (row.lease_owner) state.leaseOwner = row.lease_owner;
    if (row.lease_until) state.leaseUntil = row.lease_until;
    return clone(state)!;
  }

  save(state: WorkflowState): void {
    const current = this.db
      .prepare("SELECT lease_owner, lease_until FROM workflow_states WHERE id = ?")
      .get(state.id) as { lease_owner?: string; lease_until?: number } | undefined;
    const leaseOwner = state.leaseOwner ?? current?.lease_owner ?? null;
    const leaseUntil = state.leaseUntil ?? current?.lease_until ?? null;
    const persisted = { ...state, leaseOwner: leaseOwner ?? undefined, leaseUntil: leaseUntil ?? undefined };
    this.db
      .prepare(
        `INSERT INTO workflow_states (id, state_json, lease_owner, lease_until)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,
           lease_owner=excluded.lease_owner, lease_until=excluded.lease_until`,
      )
      .run(
        state.id,
        JSON.stringify(clone(persisted)),
        leaseOwner,
        leaseUntil,
      );
  }

  claim(state: WorkflowState, owner: string, leaseMs: number): boolean {
    const nowMs = Date.now();
    const leaseUntil = nowMs + Math.max(1_000, leaseMs);
    const claim = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT lease_owner, lease_until FROM workflow_states WHERE id = ?")
        .get(state.id) as { lease_owner?: string; lease_until?: number } | undefined;
      if (row?.lease_owner && (row.lease_until ?? 0) > nowMs && row.lease_owner !== owner)
        return false;
      const claimed = { ...state, leaseOwner: owner, leaseUntil };
      this.db
        .prepare(
          `INSERT INTO workflow_states (id, state_json, lease_owner, lease_until)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,
             lease_owner=excluded.lease_owner, lease_until=excluded.lease_until`,
        )
        .run(state.id, JSON.stringify(clone(claimed)), owner, leaseUntil);
      return true;
    });
    return claim();
  }

  release(id: string, owner: string): void {
    this.db
      .prepare("UPDATE workflow_states SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?")
      .run(id, owner);
  }

  /** Heartbeat-only renewal: touches just the lease columns, skipping the
   * JSON.stringify + full-row rewrite that save() does. Returns false (and
   * renews nothing) if this owner no longer holds the lease, so a lost
   * lease is never silently re-extended. */
  renewLease(id: string, owner: string, leaseMs: number): boolean {
    const leaseUntil = Date.now() + Math.max(1_000, leaseMs);
    const result = this.db
      .prepare(
        "UPDATE workflow_states SET lease_until = ? WHERE id = ? AND lease_owner = ?",
      )
      .run(leaseUntil, id, owner);
    return result.changes > 0;
  }

  listActive(): WorkflowState[] {
    return (this.db
      .prepare("SELECT state_json, lease_owner, lease_until FROM workflow_states")
      .all() as Array<{ state_json: string; lease_owner?: string; lease_until?: number }>)
      .map((row) => {
        const state = JSON.parse(row.state_json) as WorkflowState;
        if (row.lease_owner) state.leaseOwner = row.lease_owner;
        if (row.lease_until) state.leaseUntil = row.lease_until;
        return state;
      })
      .filter((state) => state.status === "pending" || state.status === "running");
  }
}

export interface WorkflowRunInput {
  objective: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  planner: WorkflowPlanner;
  executor: WorkflowExecutor;
  verifier: WorkflowVerifier;
  contextProvider?: (
    objective: string,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  memoryProvider?: (
    sessionId: string | undefined,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  recover?: (error: unknown, context: WorkflowContext) => Promise<void>;
  signal?: AbortSignal;
  taskId?: string;
  maxRetries?: number;
  heartbeatIntervalMs?: number;
  onProgress?: (state: WorkflowState) => void;
}
export interface BackgroundWorkflowHandle {
  taskId: string;
  promise: Promise<AgentRun>;
  cancel(): void;
}

/** Authoritative loop: Input -> Context/Memory -> Plan -> Execute Tools -> Observe -> Verify -> Continue/Recover -> Final Result. */
export class WorkflowEngine {
  private readonly active = new Map<string, Promise<AgentRun>>();
  constructor(
    private readonly recorder = new AgentRunRecorder(),
    private readonly store: WorkflowStateStore = new InMemoryWorkflowStateStore(),
  ) {}

  run(input: WorkflowRunInput): Promise<AgentRun> {
    const taskId = input.taskId ?? crypto.randomUUID();
    const existing = this.active.get(taskId);
    if (existing) return existing;
    let persisted = this.store.get(taskId);
    if (
      persisted?.status === "completed" ||
      persisted?.status === "cancelled"
    ) {
      throw new Error(`Workflow ${taskId} is already ${persisted.status}`);
    }
    const owner = `${process.pid}:${crypto.randomUUID()}`;
    if (this.store.claim) {
      const claimState =
        persisted ??
        ({
          id: taskId,
          objective: input.objective,
          sessionId: input.sessionId,
          status: "pending",
          steps: [],
          cursor: 0,
          attempts: 0,
          errors: [],
          createdAt: now(),
          updatedAt: now(),
        } satisfies WorkflowState);
      if (!this.store.claim(claimState, owner, 60_000)) {
        throw new Error(`Workflow ${taskId} is currently leased by another worker`);
      }
      persisted = this.store.get(taskId) ?? claimState;
    }
    const promise = this.execute(input, taskId, persisted, owner).finally(() =>
      (this.active.delete(taskId), this.store.release?.(taskId, owner)),
    );
    this.active.set(taskId, promise);
    return promise;
  }

  startBackground(input: WorkflowRunInput): BackgroundWorkflowHandle {
    const controller = new AbortController();
    const taskId = input.taskId ?? crypto.randomUUID();
    const promise = this.run({ ...input, taskId, signal: controller.signal });
    return {
      taskId,
      promise,
      cancel: () => controller.abort(new Error("Workflow cancelled")),
    };
  }

  resume(
    taskId: string,
    input: Omit<WorkflowRunInput, "taskId" | "objective"> & {
      objective?: string;
    },
  ): Promise<AgentRun> {
    const state = this.store.get(taskId);
    if (!state) throw new Error(`Workflow state not found: ${taskId}`);
    return this.run({
      ...input,
      taskId,
      objective: input.objective ?? state.objective,
    });
  }
  listActive(): WorkflowState[] {
    return this.store.listActive();
  }
  getState(taskId: string): WorkflowState | null {
    return this.store.get(taskId);
  }

  private async execute(
    input: WorkflowRunInput,
    taskId: string,
    persisted: WorkflowState | null,
    owner: string,
  ): Promise<AgentRun> {
    const signal = input.signal ?? new AbortController().signal;
    let state = persisted ?? (await this.initialize(input, taskId, signal));
    // A process may stop while context/memory/planning is still in progress.
    // Such a checkpoint intentionally has no steps yet; re-enter planning
    // rather than allowing the empty loop below to mark it completed.
    if (state.steps.length === 0) {
      state = await this.initialize(input, taskId, signal);
    }
    const run = this.recorder.create(
      input.objective,
      state.steps.map((step) => step.title),
    );
    const recorderId = run.id;
    for (let index = 0; index < state.cursor; index += 1) {
      const prior = state.steps[index];
      if (prior)
        this.recorder.completeStep(recorderId, `step-${index + 1}`, {
          kind: "manual",
          summary: `Resumed after completed step: ${prior.title}`,
          ok: true,
          source: "manual",
        });
    }
    state.status = "running";
    this.checkpoint(state, input);
    const heartbeatTimer = setInterval(
      () => {
        state.heartbeatAt = now();
        // Renewing the lease doesn't need a full state rewrite - only fall
        // back to store.claim/checkpoint's full save() when the store can't
        // do a lease-only renewal, or when real progress happened since the
        // last checkpoint and needs to be persisted anyway.
        const leaseRenewed = this.store.renewLease?.(state.id, owner, 60_000);
        if (leaseRenewed === undefined) this.store.claim?.(state, owner, 60_000);
        this.checkpoint(state, input);
      },
      Math.max(250, input.heartbeatIntervalMs ?? 30_000),
    );
    try {
      while (state.cursor < state.steps.length) {
        this.throwIfStopped(signal);
        const step = state.steps[state.cursor];
        if (!step) break;
        step.status = "running";
        step.attempts += 1;
        state.attempts += 1;
        this.checkpoint(state, input);
        const context = await this.buildContext(
          input,
          state,
          signal,
          step.attempts,
        );
        const recorded = `step-${state.cursor + 1}`;
        this.recorder.startStep(recorderId, recorded);
        this.recorder.recordPlannerStep(
          recorderId,
          recorded,
          `Planned: ${step.title}`,
          { taskId },
        );
        let result: ExecutionResult | undefined;
        let lastError: unknown;
        const retries = Math.max(0, input.maxRetries ?? 2);
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          this.throwIfStopped(signal);
          try {
            result = await input.executor.execute(step, {
              ...context,
              attempt: attempt + 1,
            });
            this.recorder.recordExecutorStep(
              recorderId,
              recorded,
              result.summary,
              { ok: result.ok, output: result.output },
            );
            if (result.ok || result.retryable === false) break;
            lastError = new Error(result.summary || "Tool execution failed");
          } catch (error: unknown) {
            lastError = error;
            result = undefined;
          }
          if (attempt < retries) {
            state.errors.push(
              `step ${step.id} attempt ${attempt + 1}: ${errorMessage(lastError)}`,
            );
            await input.recover?.(lastError, {
              ...context,
              attempt: attempt + 1,
            });
            this.checkpoint(state, input);
          }
        }
        if (!result?.ok) {
          const error =
            lastError ?? new Error(result?.summary || "Tool execution failed");
          step.status = "failed";
          step.error = errorMessage(error);
          this.recorder.failStep(recorderId, recorded, error);
          state.status = "failed";
          this.checkpoint(state, input);
          return this.recorder.get(recorderId) ?? run;
        }
        this.throwIfStopped(signal);
        const evidence = await input.verifier.verify(step, result, context);
        this.recorder.completeStep(recorderId, recorded, evidence);
        step.output = result.output;
        if (!evidence.ok) {
          step.status = "failed";
          step.error = evidence.summary;
          state.status = "failed";
          this.checkpoint(state, input);
          return this.recorder.get(recorderId) ?? run;
        }
        step.status = "completed";
        state.cursor += 1;
        state.heartbeatAt = now();
        this.checkpoint(state, input);
      }
      state.status = "completed";
      state.result = { ok: true, summary: "Workflow completed" };
      this.checkpoint(state, input);
      return this.recorder.get(recorderId) ?? run;
    } catch (error: unknown) {
      if (signal.aborted) {
        state.status = "pending";
        this.checkpoint(state, input);
        throw error;
      }
      state.status = "failed";
      state.errors.push(errorMessage(error));
      this.checkpoint(state, input);
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async initialize(
    input: WorkflowRunInput,
    taskId: string,
    signal: AbortSignal,
  ): Promise<WorkflowState> {
    // Persist a planning record before invoking user/model providers. If the
    // process stops during context, memory, or planning, the run remains
    // discoverable instead of disappearing before its first checkpoint.
    const timestamp = now();
    let state: WorkflowState = {
      id: taskId,
      objective: input.objective,
      sessionId: input.sessionId,
      status: "pending",
      steps: [],
      cursor: 0,
      attempts: 0,
      errors: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.save(state);

    const context = input.contextProvider
      ? await input.contextProvider(input.objective, signal)
      : undefined;
    state.context = context;
    this.store.save(state);
    const memory = input.memoryProvider
      ? await input.memoryProvider(input.sessionId, signal)
      : undefined;
    state.memory = memory;
    this.store.save(state);
    const planned = await input.planner.plan(input.objective, signal);
    if (planned.length === 0)
      throw new Error("Planner returned no executable steps");
    state = {
      ...state,
      steps: planned.map((step) => ({
        ...step,
        status: "pending",
        attempts: 0,
      })),
      updatedAt: now(),
    };
    this.store.save(state);
    return state;
  }
  private async buildContext(
    input: WorkflowRunInput,
    state: WorkflowState,
    signal: AbortSignal,
    attempt: number,
  ): Promise<WorkflowContext> {
    return {
      runId: state.id,
      sessionId: state.sessionId,
      signal,
      idempotencyKey: `${state.id}:${state.steps[state.cursor]?.id ?? state.cursor}`,
      metadata: input.metadata,
      context: state.context,
      memory: state.memory,
      stepIndex: state.cursor,
      attempt,
    };
  }
  private lastCheckpointSignature: string | undefined;

  /** A cheap fingerprint of everything that actually matters for resuming a
   * workflow. Deliberately excludes heartbeatAt/updatedAt/lease fields,
   * which change on every tick regardless of real progress. */
  private checkpointSignature(state: WorkflowState): string {
    const step = state.steps[state.cursor];
    return JSON.stringify([
      state.status,
      state.cursor,
      state.attempts,
      state.errors.length,
      step?.status,
      step?.attempts,
      step?.error,
    ]);
  }

  private checkpoint(
    state: WorkflowState,
    input: WorkflowRunInput,
    force = false,
  ): void {
    state.updatedAt = now();
    const signature = this.checkpointSignature(state);
    if (!force && signature === this.lastCheckpointSignature) {
      // Nothing that affects resumability changed since the last write
      // (e.g. a heartbeat tick between step transitions) - skip the full
      // JSON.stringify + disk write.
      input.onProgress?.(clone(state)!);
      return;
    }
    this.lastCheckpointSignature = signature;
    this.store.save(state);
    input.onProgress?.(clone(state)!);
  }
  private throwIfStopped(signal: AbortSignal): void {
    if (signal.aborted)
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Workflow aborted");
  }
}
function now(): string {
  return new Date().toISOString();
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function clone<T>(value: T | undefined): T | undefined {
  return value === undefined
    ? undefined
    : (JSON.parse(JSON.stringify(value)) as T);
}
function isWorkflowState(value: unknown): value is WorkflowState {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.objective === "string" &&
    Array.isArray(item.steps) &&
    typeof item.cursor === "number" &&
    typeof item.status === "string"
  );
}
const workflowStatePath =
  process.env.MIKI_WORKFLOW_STATE_PATH ||
  path.resolve(
    process.env.MIKI_WORKSPACE_DIR || process.cwd(),
    "data",
    "workflows.sqlite",
  );
fs.mkdirSync(path.dirname(workflowStatePath), { recursive: true });
const workflowDb = new Database(workflowStatePath);
export const globalWorkflowEngine = new WorkflowEngine(
  undefined,
  new SqliteWorkflowStateStore(workflowDb),
);
