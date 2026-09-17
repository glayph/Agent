import Database from "better-sqlite3";
import {
  AgentRunRecorder,
  SqliteAgentRunStore,
  type AgentRun,
  type VerificationEvidence,
} from "./agent-run.js";
import { parseCronToNextRun, type ScheduledTask } from "./scheduler.js";

export type AutomationStatus = "active" | "paused" | "disabled";
export type AutomationTarget = "internal" | "research" | "facebook" | "youtube";
export type AutomationApprovalMode = "none" | "review" | "publish";
export type AutomationExecutionStatus =
  "pending" | "running" | "completed" | "failed" | "cancelled";

export interface AutomationDefinition {
  id: string;
  name: string;
  objective: string;
  sessionId: string;
  steps: string[];
  target: AutomationTarget;
  approvalMode: AutomationApprovalMode;
  cronExpression?: string;
  runAt?: number;
  timezone: string;
  maxAttempts: number;
  status: AutomationStatus;
  scheduledTaskId?: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
}

export interface AutomationExecution {
  id: string;
  automationId: string;
  runId: string;
  scheduledTaskId?: string;
  status: AutomationExecutionStatus;
  trigger: "manual" | "scheduled";
  startedAt?: number;
  completedAt?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAutomationInput {
  name?: string;
  objective: string;
  sessionId?: string;
  steps?: string[];
  target?: AutomationTarget;
  approvalMode?: AutomationApprovalMode;
  cronExpression?: string;
  runAt?: number;
  timezone?: string;
  maxAttempts?: number;
}

export interface UpdateAutomationInput {
  name?: string;
  objective?: string;
  steps?: string[];
  target?: AutomationTarget;
  approvalMode?: AutomationApprovalMode;
  cronExpression?: string | null;
  runAt?: number | null;
  timezone?: string;
  maxAttempts?: number;
}

interface AutomationRow {
  id: string;
  name: string;
  objective: string;
  session_id: string;
  steps_json: string;
  target: AutomationTarget;
  approval_mode: AutomationApprovalMode;
  cron_expression: string | null;
  run_at: number | null;
  timezone: string;
  max_attempts: number;
  status: AutomationStatus;
  scheduled_task_id: string | null;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
}

interface AutomationExecutionRow {
  id: string;
  automation_id: string;
  run_id: string;
  scheduled_task_id: string | null;
  status: AutomationExecutionStatus;
  trigger: "manual" | "scheduled";
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface AutomationScheduler {
  scheduleTask(
    sessionId: string,
    message: string,
    cronExpression?: string,
    runAt?: number,
    options?: { maxAttempts?: number },
  ): ScheduledTask;
  cancelScheduledTask(taskId: string): boolean;
}

export class SqliteAutomationStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.ensureSchema();
  }

  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        objective TEXT NOT NULL,
        session_id TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        target TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        cron_expression TEXT,
        run_at INTEGER,
        timezone TEXT NOT NULL,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        status TEXT NOT NULL,
        scheduled_task_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_at INTEGER,
        next_run_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_automations_status_next_run
        ON automations(status, next_run_at);
      CREATE TABLE IF NOT EXISTS automation_executions (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        scheduled_task_id TEXT,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (automation_id) REFERENCES automations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_automation_executions_automation
        ON automation_executions(automation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_automation_executions_run
        ON automation_executions(run_id);
    `);
  }

  create(input: {
    name: string;
    objective: string;
    sessionId: string;
    steps: string[];
    target: AutomationTarget;
    approvalMode: AutomationApprovalMode;
    cronExpression?: string;
    runAt?: number;
    timezone: string;
    maxAttempts: number;
  }): AutomationDefinition {
    const now = Date.now();
    const automation: AutomationDefinition = {
      id: crypto.randomUUID(),
      name: input.name,
      objective: input.objective,
      sessionId: input.sessionId,
      steps: input.steps,
      target: input.target,
      approvalMode: input.approvalMode,
      cronExpression: input.cronExpression,
      runAt: input.runAt,
      timezone: input.timezone,
      maxAttempts: input.maxAttempts,
      status: "active",
      createdAt: now,
      updatedAt: now,
      nextRunAt: input.runAt,
    };
    this.save(automation);
    return automation;
  }

  save(automation: AutomationDefinition): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO automations
        (id, name, objective, session_id, steps_json, target, approval_mode,
         cron_expression, run_at, timezone, max_attempts, status,
         scheduled_task_id, created_at, updated_at, last_run_at, next_run_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        automation.id,
        automation.name,
        automation.objective,
        automation.sessionId,
        JSON.stringify(automation.steps),
        automation.target,
        automation.approvalMode,
        automation.cronExpression ?? null,
        automation.runAt ?? null,
        automation.timezone,
        automation.maxAttempts,
        automation.status,
        automation.scheduledTaskId ?? null,
        automation.createdAt,
        automation.updatedAt,
        automation.lastRunAt ?? null,
        automation.nextRunAt ?? null,
      );
  }

  list(limit = 100): AutomationDefinition[] {
    const rows = this.db
      .prepare(`SELECT * FROM automations ORDER BY updated_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(500, limit))) as AutomationRow[];
    return rows.map((row) => this.fromRow(row));
  }

  get(id: string): AutomationDefinition | null {
    const row = this.db
      .prepare("SELECT * FROM automations WHERE id = ?")
      .get(id) as AutomationRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  createExecution(input: {
    automationId: string;
    runId: string;
    scheduledTaskId?: string;
    trigger: "manual" | "scheduled";
  }): AutomationExecution {
    const now = Date.now();
    const execution: AutomationExecution = {
      id: crypto.randomUUID(),
      automationId: input.automationId,
      runId: input.runId,
      scheduledTaskId: input.scheduledTaskId,
      status: "pending",
      trigger: input.trigger,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO automation_executions
        (id, automation_id, run_id, scheduled_task_id, status, trigger,
         started_at, completed_at, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execution.id,
        execution.automationId,
        execution.runId,
        execution.scheduledTaskId ?? null,
        execution.status,
        execution.trigger,
        null,
        null,
        null,
        execution.createdAt,
        execution.updatedAt,
      );
    return execution;
  }

  getExecution(id: string): AutomationExecution | null {
    const row = this.db
      .prepare("SELECT * FROM automation_executions WHERE id = ?")
      .get(id) as AutomationExecutionRow | undefined;
    return row ? this.executionFromRow(row) : null;
  }

  getExecutionByRunId(runId: string): AutomationExecution | null {
    const row = this.db
      .prepare(
        "SELECT * FROM automation_executions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(runId) as AutomationExecutionRow | undefined;
    return row ? this.executionFromRow(row) : null;
  }

  listExecutions(automationId: string, limit = 100): AutomationExecution[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM automation_executions
         WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(
        automationId,
        Math.max(1, Math.min(500, limit)),
      ) as AutomationExecutionRow[];
    return rows.map((row) => this.executionFromRow(row));
  }

  updateExecution(
    id: string,
    patch: Partial<
      Pick<
        AutomationExecution,
        "scheduledTaskId" | "status" | "startedAt" | "completedAt" | "error"
      >
    >,
  ): AutomationExecution | null {
    const current = this.getExecution(id);
    if (!current) return null;
    const next: AutomationExecution = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE automation_executions SET scheduled_task_id = ?, status = ?, started_at = ?,
         completed_at = ?, error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.scheduledTaskId ?? null,
        next.status,
        next.startedAt ?? null,
        next.completedAt ?? null,
        next.error ?? null,
        next.updatedAt,
        next.id,
      );
    return next;
  }

  updateAutomation(
    id: string,
    patch: Partial<AutomationDefinition>,
  ): AutomationDefinition | null {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.save(next);
    return next;
  }

  private fromRow(row: AutomationRow): AutomationDefinition {
    let steps: string[] = [];
    try {
      const parsed = JSON.parse(row.steps_json);
      if (Array.isArray(parsed)) {
        steps = parsed.filter(
          (value): value is string => typeof value === "string",
        );
      }
    } catch {
      steps = [];
    }
    return {
      id: row.id,
      name: row.name,
      objective: row.objective,
      sessionId: row.session_id,
      steps,
      target: row.target,
      approvalMode: row.approval_mode,
      cronExpression: row.cron_expression ?? undefined,
      runAt: row.run_at ?? undefined,
      timezone: row.timezone,
      maxAttempts: row.max_attempts,
      status: row.status,
      scheduledTaskId: row.scheduled_task_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRunAt: row.last_run_at ?? undefined,
      nextRunAt: row.next_run_at ?? undefined,
    };
  }

  private executionFromRow(row: AutomationExecutionRow): AutomationExecution {
    return {
      id: row.id,
      automationId: row.automation_id,
      runId: row.run_id,
      scheduledTaskId: row.scheduled_task_id ?? undefined,
      status: row.status,
      trigger: row.trigger,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export function buildAutomationMessage(
  automationId: string,
  executionId: string,
  objective: string,
): string {
  return `[[miki-automation:${automationId}:${executionId}]]\n${objective}`;
}

export function parseAutomationMessage(message: string): {
  automationId: string;
  executionId: string;
  prompt: string;
} | null {
  const match = message.match(
    /^\[\[miki-automation:([^:]+):([^\]]+)\]\]\s*\n?([\s\S]*)$/,
  );
  if (!match) return null;
  return {
    automationId: match[1],
    executionId: match[2],
    prompt: match[3].trim(),
  };
}

export class AutomationManager {
  private readonly runRecorder: AgentRunRecorder;

  constructor(
    private readonly store: SqliteAutomationStore,
    private readonly scheduler: AutomationScheduler,
    agentRunDbPath: string,
  ) {
    this.runRecorder = new AgentRunRecorder(
      new SqliteAgentRunStore(agentRunDbPath),
    );
  }

  list(limit?: number): AutomationDefinition[] {
    return this.store.list(limit);
  }

  get(id: string): AutomationDefinition | null {
    return this.store.get(id);
  }

  executions(id: string, limit?: number): AutomationExecution[] {
    return this.store.listExecutions(id, limit);
  }

  create(input: CreateAutomationInput): AutomationDefinition {
    const objective = input.objective.trim();
    if (!objective) throw new Error("objective is required");
    const target = input.target ?? "internal";
    this.validateTarget(target);
    this.validateSchedule(input.cronExpression, input.runAt);
    const steps = (input.steps ?? ["Execute the automation objective"])
      .map((step) => step.trim())
      .filter(Boolean);
    if (steps.length === 0) throw new Error("at least one step is required");
    const automation = this.store.create({
      name: input.name?.trim() || objective.slice(0, 60),
      objective,
      sessionId: input.sessionId?.trim() || "miki-automation",
      steps,
      target,
      approvalMode: input.approvalMode ?? "review",
      cronExpression: input.cronExpression?.trim() || undefined,
      runAt: input.runAt,
      timezone: input.timezone?.trim() || "UTC",
      maxAttempts: Math.max(
        1,
        Math.min(10, Math.floor(input.maxAttempts ?? 3)),
      ),
    });
    return this.scheduleDefinition(automation);
  }

  update(id: string, input: UpdateAutomationInput): AutomationDefinition {
    const current = this.store.get(id);
    if (!current) throw new Error("Automation not found");
    const effectiveCron =
      input.cronExpression !== undefined
        ? input.cronExpression?.trim() || undefined
        : current.cronExpression;
    const effectiveRunAt =
      input.runAt !== undefined ? (input.runAt ?? undefined) : current.runAt;
    const effectiveTarget = input.target ?? current.target;
    this.validateTarget(effectiveTarget);
    this.validateSchedule(effectiveCron, effectiveRunAt);
    const nextSteps =
      input.steps === undefined
        ? current.steps
        : input.steps.map((step) => step.trim()).filter(Boolean);
    if (nextSteps.length === 0)
      throw new Error("at least one step is required");
    if (current.scheduledTaskId)
      this.scheduler.cancelScheduledTask(current.scheduledTaskId);
    const next = this.store.updateAutomation(id, {
      ...(input.name !== undefined
        ? { name: input.name.trim() || current.name }
        : {}),
      ...(input.objective !== undefined
        ? { objective: input.objective.trim() || current.objective }
        : {}),
      ...(input.steps !== undefined ? { steps: nextSteps } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.approvalMode !== undefined
        ? { approvalMode: input.approvalMode }
        : {}),
      ...(input.cronExpression !== undefined
        ? { cronExpression: input.cronExpression?.trim() || undefined }
        : {}),
      ...(input.runAt !== undefined ? { runAt: input.runAt ?? undefined } : {}),
      ...(input.timezone !== undefined
        ? { timezone: input.timezone.trim() || current.timezone }
        : {}),
      ...(input.maxAttempts !== undefined
        ? {
            maxAttempts: Math.max(
              1,
              Math.min(10, Math.floor(input.maxAttempts)),
            ),
          }
        : {}),
      scheduledTaskId: undefined,
      nextRunAt: input.runAt ?? current.runAt,
      status: current.status === "disabled" ? "disabled" : "active",
    });
    if (!next) throw new Error("Automation not found");
    return next.status === "active" ? this.scheduleDefinition(next) : next;
  }

  pause(id: string): AutomationDefinition {
    const current = this.store.get(id);
    if (!current) throw new Error("Automation not found");
    if (current.scheduledTaskId)
      this.scheduler.cancelScheduledTask(current.scheduledTaskId);
    return this.store.updateAutomation(id, {
      status: "paused",
      scheduledTaskId: undefined,
      nextRunAt: undefined,
    })!;
  }

  resume(id: string): AutomationDefinition {
    const current = this.store.get(id);
    if (!current) throw new Error("Automation not found");
    return this.scheduleDefinition(
      this.store.updateAutomation(id, { status: "active" })!,
    );
  }

  cancel(id: string): AutomationDefinition {
    const current = this.store.get(id);
    if (!current) throw new Error("Automation not found");
    if (current.scheduledTaskId)
      this.scheduler.cancelScheduledTask(current.scheduledTaskId);
    for (const execution of this.store.listExecutions(id, 500)) {
      if (execution.scheduledTaskId)
        this.scheduler.cancelScheduledTask(execution.scheduledTaskId);
      if (execution.status === "pending" || execution.status === "running") {
        this.store.updateExecution(execution.id, {
          status: "cancelled",
          completedAt: Date.now(),
          error: "Cancelled by user",
        });
      }
    }
    return this.store.updateAutomation(id, {
      status: "disabled",
      scheduledTaskId: undefined,
      nextRunAt: undefined,
    })!;
  }

  runNow(id: string): AutomationExecution {
    const automation = this.store.get(id);
    if (!automation) throw new Error("Automation not found");
    if (automation.status !== "active") {
      throw new Error("Only active automations can be run now");
    }
    this.validateTarget(automation.target);
    return this.createAndScheduleExecution(automation, "manual", Date.now());
  }

  prepareExecution(executionId: string): string {
    const current = this.store.getExecution(executionId);
    if (!current) return executionId;
    if (current.status === "pending" || current.status === "running")
      return executionId;
    const automation = this.store.get(current.automationId);
    if (
      !automation ||
      automation.status !== "active" ||
      !automation.cronExpression
    ) {
      return executionId;
    }
    return this.createExecutionRecord(automation, "scheduled").id;
  }

  onExecutionStarted(executionId: string): void {
    const before = this.store.getExecution(executionId);
    if (!before || ["completed", "failed", "cancelled"].includes(before.status))
      return;
    this.store.updateExecution(executionId, {
      status: "running",
      startedAt: Date.now(),
    });
    const execution = this.store.getExecution(executionId);
    if (!execution) return;
    const run = this.runRecorder.get(execution.runId);
    if (!run) return;
    const step = run.steps.find((item) => item.status === "pending");
    if (step) this.runRecorder.startStep(run.id, step.id);
  }

  onExecutionCompleted(executionId: string): void {
    const before = this.store.getExecution(executionId);
    if (!before || ["completed", "failed", "cancelled"].includes(before.status))
      return;
    this.store.updateExecution(executionId, {
      status: "completed",
      completedAt: Date.now(),
    });
    const execution = this.store.getExecution(executionId);
    if (!execution) return;
    const run = this.runRecorder.get(execution.runId);
    if (!run) return;
    for (const step of run.steps) {
      const latest = this.runRecorder.get(run.id);
      const current = latest?.steps.find((item) => item.id === step.id);
      if (!current || current.status === "completed") continue;
      if (current.status === "pending")
        this.runRecorder.startStep(run.id, current.id);
      const evidence: VerificationEvidence = {
        kind: "manual",
        summary: "Automation task completed successfully",
        ok: true,
        source: "executor",
        phase: "executor",
        metadata: { executionId },
      };
      this.runRecorder.completeStep(run.id, current.id, evidence);
    }
  }

  onExecutionFailed(executionId: string, error: unknown): void {
    const before = this.store.getExecution(executionId);
    if (!before || ["completed", "failed", "cancelled"].includes(before.status))
      return;
    this.store.updateExecution(executionId, {
      status: "failed",
      completedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
    const execution = this.store.getExecution(executionId);
    if (!execution) return;
    const run = this.runRecorder.get(execution.runId);
    if (!run) return;
    const step = run.steps.find(
      (item) => item.status === "pending" || item.status === "running",
    );
    if (!step) return;
    if (step.status === "pending") this.runRecorder.startStep(run.id, step.id);
    this.runRecorder.failStep(run.id, step.id, error);
  }

  private validateTarget(target: AutomationTarget): void {
    if (target === "facebook" || target === "youtube") {
      throw new Error(
        `${target} automation adapter is not configured yet; use internal or research target`,
      );
    }
  }

  private validateSchedule(cronExpression?: string, runAt?: number): void {
    if (cronExpression === undefined && runAt === undefined) {
      throw new Error("cronExpression or runAt is required");
    }
    if (
      cronExpression !== undefined &&
      parseCronToNextRun(cronExpression.trim()) === null
    ) {
      throw new Error(
        `Unsupported schedule expression: ${cronExpression.trim()}`,
      );
    }
    if (runAt !== undefined && (!Number.isSafeInteger(runAt) || runAt < 0)) {
      throw new Error("runAt must be a non-negative safe integer timestamp.");
    }
    if (runAt !== undefined && runAt <= Date.now()) {
      throw new Error("runAt must be scheduled in the future.");
    }
  }

  private scheduleDefinition(
    automation: AutomationDefinition,
  ): AutomationDefinition {
    this.validateTarget(automation.target);
    if (!automation.cronExpression && automation.runAt === undefined) {
      return automation;
    }
    const execution = this.createExecutionRecord(automation, "scheduled");
    const scheduled = this.scheduler.scheduleTask(
      automation.sessionId,
      buildAutomationMessage(automation.id, execution.id, automation.objective),
      automation.cronExpression,
      automation.runAt,
      { maxAttempts: automation.maxAttempts },
    );
    this.store.updateExecution(execution.id, { scheduledTaskId: scheduled.id });
    return this.store.updateAutomation(automation.id, {
      scheduledTaskId: scheduled.id,
      nextRunAt: scheduled.runAt,
      updatedAt: Date.now(),
    })!;
  }

  private createAndScheduleExecution(
    automation: AutomationDefinition,
    trigger: "manual" | "scheduled",
    runAt: number,
  ): AutomationExecution {
    this.validateTarget(automation.target);
    const execution = this.createExecutionRecord(automation, trigger);
    const scheduled = this.scheduler.scheduleTask(
      automation.sessionId,
      buildAutomationMessage(automation.id, execution.id, automation.objective),
      undefined,
      runAt,
      { maxAttempts: automation.maxAttempts },
    );
    this.store.updateAutomation(automation.id, {
      lastRunAt: Date.now(),
      updatedAt: Date.now(),
    });
    return this.store.updateExecution(execution.id, {
      scheduledTaskId: scheduled.id,
      status: "pending",
    })!;
  }

  private createExecutionRecord(
    automation: AutomationDefinition,
    trigger: "manual" | "scheduled",
  ): AutomationExecution {
    const run = this.runRecorder.create(automation.objective, automation.steps);
    return this.store.createExecution({
      automationId: automation.id,
      runId: run.id,
      trigger,
    });
  }
}

export function getAutomationRunId(message: string): string | null {
  return parseAutomationMessage(message)?.executionId ?? null;
}

export function getAutomationPrompt(message: string): string {
  return parseAutomationMessage(message)?.prompt ?? message;
}

export function createAutomationRuntime(
  automationDbPath: string,
  agentRunDbPath: string,
  scheduler: AutomationScheduler,
): AutomationManager {
  return new AutomationManager(
    new SqliteAutomationStore(automationDbPath),
    scheduler,
    agentRunDbPath,
  );
}

export type { AgentRun };
