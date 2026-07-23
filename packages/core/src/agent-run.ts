import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { redactSecrets } from "@hiro/config";
import { normalizeAgentError, type NormalizedAgentError } from "./errors.js";

export type TaskGraphStepStatus =
  "pending" | "running" | "completed" | "failed" | "skipped";

export interface VerificationEvidence {
  kind: "command" | "file" | "api" | "manual" | "metric";
  summary: string;
  ok: boolean;
  source?:
    | "planner"
    | "executor"
    | "verifier"
    | "model"
    | "tool"
    | "test"
    | "build"
    | "smoke"
    | "dashboard"
    | "manual";
  phase?: "planner" | "executor" | "verifier";
  capturedAt?: string;
  metadata?: Record<string, unknown>;
  modelCall?: ModelCallMetadata;
  toolCall?: ToolCallMetadata;
  permission?: ToolPermissionDecisionMetadata;
  data?: Record<string, unknown>;
}

export interface ModelCallMetadata {
  provider?: string;
  model?: string;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  cached?: boolean;
}

export interface ToolPermissionDecisionMetadata {
  toolName: string;
  decision: "allowed" | "denied";
  reason?: string;
  policy?: string;
  sessionId?: string;
}

export interface ToolCallMetadata {
  toolName: string;
  callId?: string;
  status?: "started" | "completed" | "failed" | "denied";
  latencyMs?: number;
  permission?: ToolPermissionDecisionMetadata;
}

export interface TaskGraphStep {
  id: string;
  title: string;
  dependsOn: string[];
  phase?: "planner" | "executor" | "verifier";
  status: TaskGraphStepStatus;
  startedAt?: string;
  completedAt?: string;
  attempts: number;
  evidence: VerificationEvidence[];
  error?: NormalizedAgentError;
}

export interface AgentRun {
  id: string;
  objective: string;
  status: TaskGraphStepStatus;
  createdAt: string;
  updatedAt: string;
  steps: TaskGraphStep[];
  timeline?: AgentRunTimelineEvent[];
  contextBudget?: Record<string, unknown>;
  retrievalDiagnostics?: Record<string, unknown>;
}

export interface AgentRunStore {
  save(run: AgentRun): void;
  get(runId: string): AgentRun | null;
  list(limit?: number): AgentRun[];
}

export interface AgentRunStepPatch {
  title?: string;
  phase?: TaskGraphStep["phase"];
  status?: TaskGraphStepStatus;
  evidence?: VerificationEvidence;
  error?: unknown;
}

export interface AgentRunExportBundle {
  schemaVersion: 1 | 2;
  exportedAt: string;
  run: AgentRun;
  replay?: {
    objective: string;
    steps: Array<{
      id: string;
      title: string;
      phase?: TaskGraphStep["phase"];
      evidenceCount: number;
      status: TaskGraphStepStatus;
    }>;
  };
}

export interface AgentRunTimelineEvent {
  id: string;
  at: string;
  stepId?: string;
  phase?: TaskGraphStep["phase"];
  source: NonNullable<VerificationEvidence["source"]> | "run";
  summary: string;
  ok?: boolean;
  metadata?: Record<string, unknown>;
}

const STEP_STATUSES = new Set<TaskGraphStepStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

const EVIDENCE_KINDS = new Set<VerificationEvidence["kind"]>([
  "command",
  "file",
  "api",
  "manual",
  "metric",
]);
const MAX_EVIDENCE_SUMMARY_CHARS = 2_000;
const MAX_EVIDENCE_DATA_CHARS = 20_000;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isTaskGraphStepStatus(
  value: unknown,
): value is TaskGraphStepStatus {
  return (
    typeof value === "string" && STEP_STATUSES.has(value as TaskGraphStepStatus)
  );
}

export function isVerificationEvidenceKind(
  value: unknown,
): value is VerificationEvidence["kind"] {
  return (
    typeof value === "string" &&
    EVIDENCE_KINDS.has(value as VerificationEvidence["kind"])
  );
}

function sanitizeEvidence(
  evidence: VerificationEvidence,
): VerificationEvidence {
  const summary = redactSecrets(normalizeText(evidence.summary)).slice(
    0,
    MAX_EVIDENCE_SUMMARY_CHARS,
  );
  return {
    kind: evidence.kind,
    summary,
    ok: evidence.ok,
    source:
      evidence.source && isEvidenceSource(evidence.source)
        ? evidence.source
        : undefined,
    phase: isTracePhase(evidence.phase) ? evidence.phase : undefined,
    capturedAt: normalizeIsoString(evidence.capturedAt) || nowIso(),
    metadata: sanitizeRecord(evidence.metadata),
    modelCall: sanitizeTelemetryRecord(
      evidence.modelCall as unknown as Record<string, unknown> | undefined,
    ) as ModelCallMetadata | undefined,
    toolCall: sanitizeRecord(
      evidence.toolCall as unknown as Record<string, unknown> | undefined,
    ) as ToolCallMetadata | undefined,
    permission: sanitizeRecord(
      evidence.permission as unknown as Record<string, unknown> | undefined,
    ) as ToolPermissionDecisionMetadata | undefined,
    data: evidence.data
      ? truncateEvidenceData(
          redactSecrets(evidence.data) as Record<string, unknown>,
        )
      : undefined,
  };
}

function sanitizeRun(run: AgentRun): AgentRun {
  const cloned = clone(run);
  return {
    ...cloned,
    objective: redactSecrets(normalizeText(cloned.objective)),
    steps: cloned.steps.map((step) => ({
      ...step,
      title: redactSecrets(normalizeText(step.title)),
      error: step.error
        ? (redactSecrets(step.error) as NormalizedAgentError)
        : undefined,
      evidence: step.evidence.map(sanitizeEvidence),
    })),
    timeline: Array.isArray(cloned.timeline)
      ? cloned.timeline.map(sanitizeTimelineEvent)
      : undefined,
    contextBudget: sanitizeTelemetryRecord(cloned.contextBudget),
    retrievalDiagnostics: sanitizeTelemetryRecord(cloned.retrievalDiagnostics),
  };
}

function sanitizeTimelineEvent(
  event: AgentRunTimelineEvent,
): AgentRunTimelineEvent {
  return {
    id: normalizeText(event.id) || crypto.randomUUID(),
    at: normalizeIsoString(event.at) || nowIso(),
    stepId: normalizeText(event.stepId) || undefined,
    phase: isTracePhase(event.phase) ? event.phase : undefined,
    source: isEvidenceSource(event.source) ? event.source : "run",
    summary: redactSecrets(normalizeText(event.summary)).slice(
      0,
      MAX_EVIDENCE_SUMMARY_CHARS,
    ),
    ok: typeof event.ok === "boolean" ? event.ok : undefined,
    metadata: sanitizeRecord(event.metadata),
  };
}

function deriveRunStatus(steps: TaskGraphStep[]): TaskGraphStepStatus {
  if (steps.length === 0) return "pending";
  if (steps.some((item) => item.status === "failed")) return "failed";
  if (steps.some((item) => item.status === "running")) return "running";
  if (
    steps.every(
      (item) => item.status === "completed" || item.status === "skipped",
    )
  ) {
    return "completed";
  }
  return "pending";
}

function unmetDependencies(
  step: TaskGraphStep,
  steps: TaskGraphStep[],
): string[] {
  const byId = new Map(steps.map((item) => [item.id, item]));
  return step.dependsOn.filter((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return !dependency || dependency.status !== "completed";
  });
}

function normalizeStep(raw: unknown): TaskGraphStep {
  const row =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    id: typeof row.id === "string" ? row.id : crypto.randomUUID(),
    title: normalizeText(row.title) || "Untitled step",
    dependsOn: Array.isArray(row.dependsOn)
      ? row.dependsOn.filter((item): item is string => typeof item === "string")
      : [],
    phase: isTracePhase(row.phase) ? row.phase : undefined,
    status: isTaskGraphStepStatus(row.status) ? row.status : "pending",
    startedAt: typeof row.startedAt === "string" ? row.startedAt : undefined,
    completedAt:
      typeof row.completedAt === "string" ? row.completedAt : undefined,
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    evidence: Array.isArray(row.evidence)
      ? row.evidence
          .filter((item): item is VerificationEvidence => {
            if (!item || typeof item !== "object") return false;
            const evidence = item as Record<string, unknown>;
            return (
              isVerificationEvidenceKind(evidence.kind) &&
              normalizeText(evidence.summary) !== "" &&
              typeof evidence.ok === "boolean"
            );
          })
          .map((item) => sanitizeEvidence(item))
      : [],
    error:
      row.error && typeof row.error === "object"
        ? (row.error as NormalizedAgentError)
        : undefined,
  };
}

export class InMemoryAgentRunStore implements AgentRunStore {
  private readonly runs = new Map<string, AgentRun>();

  save(run: AgentRun): void {
    this.runs.set(run.id, sanitizeRun(run));
  }

  get(runId: string): AgentRun | null {
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  list(limit = 50): AgentRun[] {
    return [...this.runs.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((run) => clone(run));
  }
}

export class SqliteAgentRunStore implements AgentRunStore {
  private readonly db: Database.Database;

  constructor(dbOrPath: Database.Database | string) {
    if (typeof dbOrPath === "string") {
      fs.mkdirSync(path.dirname(dbOrPath), { recursive: true });
      this.db = new Database(dbOrPath);
    } else {
      this.db = dbOrPath;
    }
    this.init();
  }

  save(run: AgentRun): void {
    const safeRun = sanitizeRun(run);
    const contextJson = JSON.stringify({
      contextBudget: safeRun.contextBudget,
      retrievalDiagnostics: safeRun.retrievalDiagnostics,
    });
    this.db
      .prepare(
        `INSERT INTO agent_runs
          (id, objective, status, steps_json, timeline_json, context_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          objective = excluded.objective,
          status = excluded.status,
          steps_json = excluded.steps_json,
          timeline_json = excluded.timeline_json,
          context_json = excluded.context_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        safeRun.id,
        safeRun.objective,
        safeRun.status,
        JSON.stringify(safeRun.steps),
        JSON.stringify(safeRun.timeline || []),
        contextJson,
        safeRun.createdAt,
        safeRun.updatedAt,
      );
  }

  get(runId: string): AgentRun | null {
    const row = this.db
      .prepare(
        `SELECT id, objective, status, steps_json, timeline_json, context_json, created_at, updated_at
         FROM agent_runs
         WHERE id = ?`,
      )
      .get(runId) as Record<string, unknown> | undefined;
    return row ? this.rowToRun(row) : null;
  }

  list(limit = 50): AgentRun[] {
    const safeLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db
      .prepare(
        `SELECT id, objective, status, steps_json, timeline_json, context_json, created_at, updated_at
         FROM agent_runs
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToRun(row));
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        timeline_json TEXT NOT NULL DEFAULT '[]',
        context_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_updated_at
        ON agent_runs(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_status_updated_at
        ON agent_runs(status, updated_at DESC);
    `);
    this.ensureColumn("timeline_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("context_json", "TEXT NOT NULL DEFAULT '{}'");
  }

  private ensureColumn(name: string, definition: string): void {
    const columns = this.db
      .prepare("PRAGMA table_info(agent_runs)")
      .all() as Array<{ name?: string }>;
    if (columns.some((column) => column.name === name)) return;
    this.db.exec(`ALTER TABLE agent_runs ADD COLUMN ${name} ${definition}`);
  }

  private rowToRun(row: Record<string, unknown>): AgentRun {
    let steps: TaskGraphStep[] = [];
    let timeline: AgentRunTimelineEvent[] = [];
    let contextBudget: Record<string, unknown> | undefined;
    let retrievalDiagnostics: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(String(row.steps_json || "[]")) as unknown;
      steps = Array.isArray(parsed) ? parsed.map(normalizeStep) : [];
    } catch {
      steps = [];
    }
    try {
      const parsed = JSON.parse(String(row.timeline_json || "[]")) as unknown;
      timeline = Array.isArray(parsed)
        ? parsed.map((event) =>
            sanitizeTimelineEvent(event as AgentRunTimelineEvent),
          )
        : [];
    } catch {
      timeline = [];
    }
    try {
      const parsed = JSON.parse(String(row.context_json || "{}")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const context = parsed as Record<string, unknown>;
        contextBudget = sanitizeTelemetryRecord(
          context.contextBudget as Record<string, unknown> | undefined,
        );
        retrievalDiagnostics = sanitizeTelemetryRecord(
          context.retrievalDiagnostics as Record<string, unknown> | undefined,
        );
      }
    } catch {
      contextBudget = undefined;
      retrievalDiagnostics = undefined;
    }
    return sanitizeRun({
      id: String(row.id || ""),
      objective: String(row.objective || ""),
      status: isTaskGraphStepStatus(row.status)
        ? row.status
        : deriveRunStatus(steps),
      createdAt: String(row.created_at || ""),
      updatedAt: String(row.updated_at || ""),
      steps,
      timeline,
      contextBudget,
      retrievalDiagnostics,
    });
  }
}

export function createTaskGraph(
  objective: string,
  titles: string[] = [
    "Understand the request and constraints",
    "Plan the execution path",
    "Apply the implementation",
    "Verify the result with evidence",
  ],
): AgentRun {
  const now = nowIso();
  const safeObjective = normalizeText(objective) || "Untitled agent run";
  const safeTitles = titles
    .map((title) => normalizeText(title))
    .filter(Boolean);
  const steps = safeTitles.map((title, index) => ({
    id: `step-${index + 1}`,
    title,
    dependsOn: index === 0 ? [] : [`step-${index}`],
    phase: defaultPhaseForStep(index, safeTitles.length),
    status: "pending" as const,
    attempts: 0,
    evidence: [],
  }));
  return {
    id: crypto.randomUUID(),
    objective: safeObjective,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    steps,
    timeline: [
      {
        id: crypto.randomUUID(),
        at: now,
        source: "run",
        summary: `Created agent run: ${safeObjective}`,
      },
    ],
  };
}

export class AgentRunRecorder {
  constructor(
    private readonly store: AgentRunStore = new InMemoryAgentRunStore(),
  ) {}

  create(objective: string, stepTitles?: string[]): AgentRun {
    const run = createTaskGraph(objective, stepTitles);
    this.store.save(run);
    return run;
  }

  startStep(runId: string, stepId: string): AgentRun {
    return this.updateStep(
      runId,
      stepId,
      (step) => {
        step.status = "running";
        step.startedAt = step.startedAt || nowIso();
        step.attempts += 1;
      },
      "Started step",
    );
  }

  completeStep(
    runId: string,
    stepId: string,
    evidence: VerificationEvidence,
  ): AgentRun {
    return this.updateStep(
      runId,
      stepId,
      (step) => {
        step.status = evidence.ok ? "completed" : "failed";
        step.completedAt = nowIso();
        step.evidence.push(sanitizeEvidence(evidence));
      },
      evidence.summary,
    );
  }

  failStep(runId: string, stepId: string, error: unknown): AgentRun {
    return this.updateStep(
      runId,
      stepId,
      (step) => {
        step.status = "failed";
        step.completedAt = nowIso();
        step.error = normalizeAgentError(error);
      },
      "Step failed",
    );
  }

  recordEvidence(
    runId: string,
    stepId: string,
    evidence: VerificationEvidence,
  ): AgentRun {
    return this.updateStep(
      runId,
      stepId,
      (step) => {
        step.evidence.push(sanitizeEvidence(evidence));
        step.status = evidence.ok ? step.status : "failed";
        if (!evidence.ok) step.completedAt = nowIso();
      },
      evidence.summary,
    );
  }

  recordPlannerStep(
    runId: string,
    stepId: string,
    summary: string,
    metadata?: Record<string, unknown>,
  ): AgentRun {
    return this.recordEvidence(runId, stepId, {
      kind: "manual",
      summary,
      ok: true,
      phase: "planner",
      source: "planner",
      metadata,
    });
  }

  recordExecutorStep(
    runId: string,
    stepId: string,
    summary: string,
    metadata?: Record<string, unknown>,
  ): AgentRun {
    return this.recordEvidence(runId, stepId, {
      kind: "manual",
      summary,
      ok: true,
      phase: "executor",
      source: "executor",
      metadata,
    });
  }

  recordVerifierEvidence(
    runId: string,
    stepId: string,
    evidence: Omit<VerificationEvidence, "phase">,
  ): AgentRun {
    return this.recordEvidence(runId, stepId, {
      ...evidence,
      phase: "verifier",
      source: evidence.source ?? "verifier",
    });
  }

  recordCommandEvidence(
    runId: string,
    stepId: string,
    summary: string,
    ok: boolean,
    data?: Record<string, unknown>,
  ): AgentRun {
    return this.recordEvidence(runId, stepId, {
      kind: "command",
      summary,
      ok,
      phase: "verifier",
      source: "test",
      data,
    });
  }

  recordModelCall(
    runId: string,
    stepId: string,
    modelCall: ModelCallMetadata,
    ok = true,
  ): AgentRun {
    return this.recordEvidence(runId, stepId, {
      kind: "metric",
      summary: `Model call ${modelCall.model || "unknown model"}`,
      ok,
      phase: "executor",
      source: "model",
      modelCall,
    });
  }

  recordToolCall(
    runId: string,
    stepId: string,
    toolCall: ToolCallMetadata,
    ok = toolCall.status !== "failed" && toolCall.status !== "denied",
  ): AgentRun {
    return this.recordEvidence(runId, stepId, {
      kind: "api",
      summary: `Tool call ${toolCall.toolName}`,
      ok,
      phase: "executor",
      source: "tool",
      toolCall,
      permission: toolCall.permission,
    });
  }

  recordContextSnapshot(
    runId: string,
    snapshot: {
      contextBudget?: Record<string, unknown>;
      retrievalDiagnostics?: Record<string, unknown>;
    },
  ): AgentRun {
    const run = this.store.get(runId);
    if (!run) throw new Error(`Agent run not found: ${runId}`);
    run.contextBudget = sanitizeTelemetryRecord(snapshot.contextBudget);
    run.retrievalDiagnostics = sanitizeTelemetryRecord(
      snapshot.retrievalDiagnostics,
    );
    run.updatedAt = nowIso();
    this.store.save(run);
    return run;
  }

  patchStep(runId: string, stepId: string, patch: AgentRunStepPatch): AgentRun {
    return this.updateStep(
      runId,
      stepId,
      (step) => {
        if (typeof patch.title === "string" && patch.title.trim()) {
          step.title = patch.title.trim();
        }
        if (patch.phase) {
          step.phase = patch.phase;
        }
        if (patch.status) {
          const wasRunning = step.status === "running";
          step.status = patch.status;
          if (patch.status === "running") {
            step.startedAt = step.startedAt || nowIso();
            if (!wasRunning) step.attempts += 1;
          }
          if (["completed", "failed", "skipped"].includes(patch.status)) {
            step.completedAt = step.completedAt || nowIso();
          }
        }
        if (patch.evidence) {
          step.evidence.push(sanitizeEvidence(patch.evidence));
          if (!patch.evidence.ok) {
            step.status = "failed";
            step.completedAt = nowIso();
          }
        }
        if (patch.error !== undefined) {
          step.error = normalizeAgentError(patch.error);
          step.status = "failed";
          step.completedAt = nowIso();
        }
      },
      patch.evidence?.summary || patch.status || "Patched step",
    );
  }

  get(runId: string): AgentRun | null {
    return this.store.get(runId);
  }

  list(limit?: number): AgentRun[] {
    return this.store.list(limit);
  }

  private updateStep(
    runId: string,
    stepId: string,
    mutate: (step: TaskGraphStep) => void,
    timelineSummary?: string,
  ): AgentRun {
    const run = this.store.get(runId);
    if (!run) throw new Error(`Agent run not found: ${runId}`);
    const step = run.steps.find((item) => item.id === stepId);
    if (!step) throw new Error(`Agent run step not found: ${stepId}`);
    mutate(step);
    if (step.status === "running" || step.status === "completed") {
      const blockedBy = unmetDependencies(step, run.steps);
      if (blockedBy.length > 0) {
        throw new Error(
          `Agent run step '${stepId}' is blocked by incomplete dependencies: ${blockedBy.join(
            ", ",
          )}`,
        );
      }
    }
    run.updatedAt = nowIso();
    run.status = deriveRunStatus(run.steps);
    appendTimelineEvent(run, step, timelineSummary);
    this.store.save(run);
    return run;
  }
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizeIsoString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function sanitizeRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return truncateEvidenceData(redactSecrets(value) as Record<string, unknown>);
}

const SAFE_NUMERIC_TELEMETRY_KEYS = new Set([
  "attempts",
  "cached",
  "candidateCount",
  "deduped",
  "durationMs",
  "elapsedMs",
  "inputTokens",
  "keywordCandidates",
  "latencyMs",
  "maxTokens",
  "outputTokens",
  "proceduralCandidates",
  "remainingTokens",
  "returned",
  "totalTokens",
  "usedTokens",
  "vectorCandidates",
]);

function sanitizeTelemetryRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const sanitized = sanitizeRecord(value);
  if (!sanitized || !value) return sanitized;
  for (const [key, childValue] of Object.entries(value)) {
    if (
      SAFE_NUMERIC_TELEMETRY_KEYS.has(key) &&
      (typeof childValue === "number" || typeof childValue === "boolean")
    ) {
      sanitized[key] = childValue;
    }
  }
  return sanitized;
}

function isTracePhase(value: unknown): value is TaskGraphStep["phase"] {
  return value === "planner" || value === "executor" || value === "verifier";
}

function isEvidenceSource(
  value: unknown,
): value is NonNullable<VerificationEvidence["source"]> | "run" {
  return (
    value === "planner" ||
    value === "executor" ||
    value === "verifier" ||
    value === "model" ||
    value === "tool" ||
    value === "test" ||
    value === "build" ||
    value === "smoke" ||
    value === "dashboard" ||
    value === "manual" ||
    value === "run"
  );
}

function defaultPhaseForStep(
  index: number,
  total: number,
): TaskGraphStep["phase"] {
  if (index === 0) return "planner";
  if (index === total - 1) return "verifier";
  return "executor";
}

function appendTimelineEvent(
  run: AgentRun,
  step: TaskGraphStep,
  summary?: string,
): void {
  const safeSummary = normalizeText(summary);
  if (!safeSummary) return;
  const event: AgentRunTimelineEvent = {
    id: crypto.randomUUID(),
    at: nowIso(),
    stepId: step.id,
    phase: step.phase,
    source: step.phase || "run",
    summary: safeSummary,
    ok: step.status === "failed" ? false : undefined,
  };
  run.timeline = [...(run.timeline || []), sanitizeTimelineEvent(event)].slice(
    -500,
  );
}

function truncateEvidenceData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const serialized = JSON.stringify(data);
  if (serialized.length <= MAX_EVIDENCE_DATA_CHARS) return data;
  return {
    truncated: true,
    preview: serialized.slice(0, MAX_EVIDENCE_DATA_CHARS),
  };
}

export function exportAgentRunBundle(run: AgentRun): AgentRunExportBundle {
  const safeRun = sanitizeRun(run);
  return {
    schemaVersion: 2,
    exportedAt: nowIso(),
    run: safeRun,
    replay: {
      objective: safeRun.objective,
      steps: safeRun.steps.map((step) => ({
        id: step.id,
        title: step.title,
        phase: step.phase,
        evidenceCount: step.evidence.length,
        status: step.status,
      })),
    },
  };
}

export function importAgentRunBundle(bundle: unknown): AgentRun | null {
  if (!bundle || typeof bundle !== "object") return null;
  const record = bundle as Record<string, unknown>;
  const schemaVersion = record.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) return null;
  if (!record.run || typeof record.run !== "object") return null;
  const run = record.run as Record<string, unknown>;
  const steps = Array.isArray(run.steps) ? run.steps.map(normalizeStep) : [];
  return sanitizeRun({
    id: typeof run.id === "string" ? run.id : crypto.randomUUID(),
    objective: normalizeText(run.objective) || "Imported agent run",
    status: isTaskGraphStepStatus(run.status)
      ? run.status
      : deriveRunStatus(steps),
    createdAt: normalizeIsoString(run.createdAt) || nowIso(),
    updatedAt: normalizeIsoString(run.updatedAt) || nowIso(),
    steps,
    timeline: Array.isArray(run.timeline)
      ? (run.timeline as AgentRunTimelineEvent[]).map(sanitizeTimelineEvent)
      : [],
    contextBudget: sanitizeTelemetryRecord(
      run.contextBudget as Record<string, unknown> | undefined,
    ),
    retrievalDiagnostics: sanitizeTelemetryRecord(
      run.retrievalDiagnostics as Record<string, unknown> | undefined,
    ),
  });
}

export const globalAgentRunRecorder = new AgentRunRecorder();

// =============================================================================
// Phase 4 — Multi-Agent Run Strategy
// =============================================================================

import type { AgentTask } from "./task-queue.js";
import type { AgentRouteDecision } from "./agent-router.js";
import type { AgentDelegator, DelegationHandle } from "./agent-delegator.js";
import type { AgentAggregator, DelegationResult } from "./agent-aggregator.js";
import type { AgentPlanner, Plan } from "./agent-planner.js";

// ---------------------------------------------------------------------------
// Strategy interfaces
// ---------------------------------------------------------------------------

export interface AgentRunResult {
  response: string;
  mode: "single_orchestrator" | "multi_agent";
  /** Only populated in multi_agent mode */
  delegationHandles?: DelegationHandle[];
  /** Aggregation result summary if applicable */
  aggregationSummary?: string;
}

export interface SingleAgentRunStrategy {
  run(task: AgentTask): Promise<AgentRunResult>;
}

// ---------------------------------------------------------------------------
// MultiAgentRunStrategy
// ---------------------------------------------------------------------------

/**
 * Execution strategy for multi-agent mode.
 *
 * Flow:
 *  1. Generate plans for the task goal
 *  2. Annotate each plan step with the best-fit specialist (planner.assignSpecialists)
 *  3. Group steps by their assigned specialist
 *  4. Delegate each group in parallel via AgentDelegator
 *  5. Aggregate results via AgentAggregator
 *  6. If any steps failed, detect failures and trigger replanning (one retry)
 */
export class MultiAgentRunStrategy {
  constructor(
    private readonly delegator: AgentDelegator,
    private readonly aggregator: AgentAggregator,
    private readonly planner: AgentPlanner,
    private readonly baseDecision: AgentRouteDecision,
    /** Available specialist IDs — used to filter plan step assignments */
    private readonly availableSpecialists: string[] = [
      "miki",
      "sage",
      "forge",
      "scout",
    ],
    private readonly timeoutMs: number = 120_000,
  ) {}

  async run(task: AgentTask): Promise<AgentRunResult> {
    // 1. Generate and annotate plans
    const plans = await this.planner.generatePlans(task.message);
    if (plans.length === 0) {
      return this._fallback(task, "No plans generated");
    }

    const bestPlan: Plan = this.planner.assignSpecialists(
      plans[0],
      this.availableSpecialists,
    );

    // 2. Delegate all steps in parallel, grouped by specialist
    const handles = await this._delegateSteps(task, bestPlan);

    // 3. Build DelegationResult[] from handles (timing is approximated)
    const results: DelegationResult[] = handles.map(
      ({ handle, stepId, specialistId, durationMs }) => ({
        stepId,
        agentId: handle.instanceId,
        specialistId,
        success: true,
        output:
          typeof handle.reply.payload === "string"
            ? handle.reply.payload
            : JSON.stringify(handle.reply.payload),
        durationMs,
      }),
    );

    // 4. Aggregate results
    const stepMap = new Map(bestPlan.steps.map((s) => [s.id, s]));
    const aggregation = this.aggregator.aggregate(results, stepMap);

    // 5. If failures detected, perform one retry round
    if (!aggregation.allSucceeded && aggregation.failedSteps.length > 0) {
      const retryTasks = aggregation.failedSteps.map((step) => ({
        decision: {
          ...this.baseDecision,
          selected: {
            ...this.baseDecision.selected,
            id: step.assignedSpecialist ?? this.baseDecision.selected.id,
          },
        },
        task: {
          ...task,
          id: `${task.id}:retry:${step.id}`,
          message: step.action,
        },
      }));

      const retryHandles = await this.delegator.delegateParallel(
        retryTasks,
        this.timeoutMs,
      );

      const retryResults: DelegationResult[] = retryHandles.map((h, i) => ({
        stepId: `retry_${aggregation.failedSteps[i].id}`,
        agentId: h.instanceId,
        specialistId: retryTasks[i].decision.selected.id,
        success: true,
        output:
          typeof h.reply.payload === "string"
            ? h.reply.payload
            : JSON.stringify(h.reply.payload),
        durationMs: 0,
      }));

      results.push(...retryResults);
    }

    const finalAggregation = this.aggregator.aggregate(results, stepMap);
    const summary = this.aggregator.summarize(finalAggregation);

    return {
      response: finalAggregation.response,
      mode: "multi_agent",
      delegationHandles: handles.map((h) => h.handle),
      aggregationSummary: summary,
    };
  }

  // ---- Private helpers ---------------------------------------------------

  private async _delegateSteps(
    task: AgentTask,
    plan: Plan,
  ): Promise<
    Array<{
      handle: DelegationHandle;
      stepId: string;
      specialistId: string;
      durationMs: number;
    }>
  > {
    const delegations = plan.steps.map(async (step) => {
      const specialistId =
        step.assignedSpecialist ?? this.baseDecision.selected.id;
      const decision: AgentRouteDecision = {
        ...this.baseDecision,
        selected: {
          ...this.baseDecision.selected,
          id: specialistId,
        },
      };

      const subtask: AgentTask = {
        ...task,
        id: `${task.id}:${step.id}`,
        message: step.action,
      };

      const start = Date.now();
      const handle = await this.delegator.delegate(
        decision,
        subtask,
        this.timeoutMs,
      );
      const durationMs = Date.now() - start;

      return { handle, stepId: step.id, specialistId, durationMs };
    });

    return Promise.all(delegations);
  }

  private _fallback(task: AgentTask, reason: string): AgentRunResult {
    return {
      response: `[MultiAgentRunStrategy fallback] ${reason}. Task: ${task.message}`,
      mode: "single_orchestrator",
    };
  }
}

// ---------------------------------------------------------------------------
// Factory helper — picks the right strategy based on the route decision
// ---------------------------------------------------------------------------

export function createRunStrategy(
  decision: AgentRouteDecision,
  delegator: AgentDelegator,
  aggregator: AgentAggregator,
  planner: AgentPlanner,
  availableSpecialists?: string[],
): MultiAgentRunStrategy | null {
  if (decision.mode !== "multi_agent") return null;
  return new MultiAgentRunStrategy(
    delegator,
    aggregator,
    planner,
    decision,
    availableSpecialists,
  );
}
