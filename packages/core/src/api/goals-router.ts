import Database from "better-sqlite3";
import { Router } from "express";

import { getErrorMessage } from "../errors.js";
import type { GoalAcceptanceContract } from "../autonomy/goal-acceptance.js";
import type { EngineTool } from "../engine/types.js";

type GoalStatus = "pending" | "active" | "completed" | "blocked" | "cancelled";
const STATUSES: readonly GoalStatus[] = [
  "pending",
  "active",
  "completed",
  "blocked",
  "cancelled",
];
const DEFAULT_STEPS = [
  "Inspect the current state",
  "Plan the approach",
  "Implement the change",
  "Verify the result",
  "Report the outcome",
];

interface GoalDbRow {
  id: number;
  title: string;
  description: string | null;
  priority: number;
  status: string;
  status_reason: string | null;
  progress: number;
  total_steps: number;
  completed_steps: number;
  context: string | null;
  source: string | null;
  steps: string;
  acceptance_contract: string | null;
  last_pursued_at: string | null;
  created_at: string;
  updated_at: string;
}

/** SQLite store backing the dashboard's "pursue goal" API. */
export class GoalStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pursue_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        priority INTEGER NOT NULL DEFAULT 5,
        status TEXT NOT NULL DEFAULT 'active',
        status_reason TEXT,
        progress REAL NOT NULL DEFAULT 0,
        total_steps INTEGER NOT NULL DEFAULT 0,
        completed_steps INTEGER NOT NULL DEFAULT 0,
        context TEXT,
        source TEXT,
        steps TEXT NOT NULL DEFAULT '[]',
        acceptance_contract TEXT,
        last_pursued_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(pursue_goals)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!columns.has("priority")) {
      this.db.exec("ALTER TABLE pursue_goals ADD COLUMN priority INTEGER NOT NULL DEFAULT 5");
    }
    if (!columns.has("context")) {
      this.db.exec("ALTER TABLE pursue_goals ADD COLUMN context TEXT");
    }
    if (!columns.has("source")) {
      this.db.exec("ALTER TABLE pursue_goals ADD COLUMN source TEXT");
    }
    if (!columns.has("steps")) {
      this.db.exec("ALTER TABLE pursue_goals ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'");
    }
    if (!columns.has("acceptance_contract")) {
      this.db.exec("ALTER TABLE pursue_goals ADD COLUMN acceptance_contract TEXT");
    }
  }

  list(limit = 50): GoalDbRow[] {
    return this.db
      .prepare("SELECT * FROM pursue_goals ORDER BY id DESC LIMIT ?")
      .all(limit) as GoalDbRow[];
  }

  get(id: number): GoalDbRow | undefined {
    return this.db.prepare("SELECT * FROM pursue_goals WHERE id = ?").get(id) as
      | GoalDbRow
      | undefined;
  }

  active(): GoalDbRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM pursue_goals WHERE status = 'active' ORDER BY id DESC LIMIT 1",
      )
      .get() as GoalDbRow | undefined;
  }

  create(input: {
    title: string;
    description?: string | null;
    priority?: number;
    context?: Record<string, unknown> | null;
    source?: string | null;
    steps: string[];
    acceptance?: GoalAcceptanceContract | null;
    replaceExisting: boolean;
  }): GoalDbRow {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      if (input.replaceExisting) {
        this.db
          .prepare(
            "UPDATE pursue_goals SET status = 'pending', updated_at = ? WHERE status = 'active'",
          )
          .run(now);
      }
      const hasActive = Boolean(this.active());
      const result = this.db
        .prepare(
          `INSERT INTO pursue_goals
             (title, description, priority, status, total_steps, steps, context, acceptance_contract, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.title,
          input.description ?? null,
          Math.max(0, Math.min(10, Math.trunc(input.priority ?? 5))),
          hasActive ? "pending" : "active",
          input.steps.length,
          JSON.stringify(input.steps),
          input.context ? JSON.stringify(input.context) : null,
          input.acceptance ? JSON.stringify(input.acceptance) : null,
          input.source ?? "dashboard",
          now,
          now,
        );
      return Number(result.lastInsertRowid);
    });
    return this.get(tx())!;
  }

  update(
    id: number,
    patch: {
      title?: string;
      description?: string | null;
      status?: GoalStatus;
      statusReason?: string;
      completedSteps?: number;
      totalSteps?: number;
      progress?: number;
      priority?: number;
      context?: Record<string, unknown> | null;
      steps?: string[];
    },
  ): GoalDbRow | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const steps = patch.steps ?? (() => {
      try { return JSON.parse(current.steps) as string[]; } catch { return []; }
    })();
    const total = patch.totalSteps ?? (patch.steps ? steps.length : current.total_steps);
    const completedRaw =
      patch.completedSteps ??
      (patch.status === "completed" ? total : current.completed_steps);
    const completed = Math.min(completedRaw, total || Number.MAX_SAFE_INTEGER);
    const status = patch.status ?? current.status;
    let progress = patch.progress ?? current.progress;
    if (patch.progress === undefined && total > 0) progress = completed / total;
    if (status === "completed" && patch.progress === undefined) progress = 1;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE pursue_goals
            SET title = ?, description = ?, priority = ?, status = ?, status_reason = ?, progress = ?, total_steps = ?,
                completed_steps = ?, context = ?, steps = ?, updated_at = ?, last_pursued_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.title ?? current.title,
        patch.description === undefined ? current.description : patch.description,
        patch.priority === undefined ? current.priority : Math.max(0, Math.min(10, Math.trunc(patch.priority))),
        status,
        patch.statusReason ?? current.status_reason,
        Math.max(0, Math.min(1, progress)),
        total,
        completed,
        patch.context === undefined ? current.context : (patch.context ? JSON.stringify(patch.context) : null),
        JSON.stringify(steps),
        now,
        now,
        id,
      );
    return this.get(id);
  }
}

function toRow(r: GoalDbRow) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    priority: r.priority,
    status: r.status,
    status_reason: r.status_reason,
    progress: r.progress,
    total_steps: r.total_steps,
    completed_steps: r.completed_steps,
    context: r.context,
    source: r.source,
    acceptance_contract: (() => {
      if (!r.acceptance_contract) return null;
      try {
        return JSON.parse(r.acceptance_contract) as GoalAcceptanceContract;
      } catch {
        return null;
      }
    })(),
    last_pursued_at: r.last_pursued_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function snapshot(store: GoalStore) {
  const activeRow = store.active();
  const goals = store.list().map(toRow);
  let activePlan: unknown = null;
  let nextStep: string | null = null;
  if (activeRow) {
    let steps: string[] = [];
    try {
      steps = JSON.parse(activeRow.steps) as string[];
    } catch {
      steps = [];
    }
    activePlan = {
      id: `goal-${activeRow.id}`,
      title: activeRow.title,
      status: "active",
      steps: steps.map((description, i) => ({
        id: i + 1,
        description,
        status:
          i < activeRow.completed_steps
            ? "completed"
            : i === activeRow.completed_steps
              ? "in_progress"
              : "pending",
        depends_on: i === 0 ? [] : [i],
      })),
      created_at: activeRow.created_at,
      updated_at: activeRow.updated_at,
    };
    nextStep = steps[activeRow.completed_steps] ?? null;
  }
  return {
    active: activeRow ? toRow(activeRow) : null,
    activePlan,
    goals,
    summary: {
      hasActiveGoal: Boolean(activeRow),
      activeGoalId: activeRow?.id ?? null,
      activePlanId: activeRow ? `goal-${activeRow.id}` : null,
      progress: activeRow?.progress ?? 0,
      completedSteps: activeRow?.completed_steps ?? 0,
      totalSteps: activeRow?.total_steps ?? 0,
      nextStep,
    },
  };
}

/** Tool adapters for normal agent runs. Autonomous runs deliberately need an explicit policy grant before mutating goals. */
export function createGoalTools(store: GoalStore): EngineTool[] {
  const parseContext = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const parseSteps = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((step): step is string => typeof step === "string" && step.trim() !== "").map((step) => step.trim()).slice(0, 50) : [];
  return [
    {
      name: "goal_create",
      description: "Create a persistent pursue goal. Complex objectives remain active across turns until completed, blocked, cancelled, or replaced.",
      risk: "config_write",
      approval: "required",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string", minLength: 1, maxLength: 500 },
          description: { type: "string", maxLength: 12000 },
          priority: { type: "integer", minimum: 0, maximum: 10 },
          steps: { type: "array", items: { type: "string" }, maxItems: 50 },
          replace_existing: { type: "boolean" },
          context: { type: "object" },
          acceptance: { type: "object" },
        },
        required: ["objective"],
        additionalProperties: false,
      },
      async execute(input) {
        const objective = typeof input.objective === "string" ? input.objective.trim() : "";
        if (!objective) throw new Error("objective is required");
        const acceptance = input.acceptance && typeof input.acceptance === "object" && !Array.isArray(input.acceptance)
          ? input.acceptance as GoalAcceptanceContract
          : null;
        const steps = parseSteps(input.steps);
        return store.create({
          title: objective,
          description: typeof input.description === "string" ? input.description.trim() : null,
          priority: typeof input.priority === "number" ? input.priority : 5,
          context: parseContext(input.context),
          source: "agent",
          steps: steps.length ? steps : DEFAULT_STEPS,
          acceptance,
          replaceExisting: input.replace_existing === true,
        });
      },
    },
    {
      name: "goal_status",
      description: "Read persistent pursue goals and current progress.",
      risk: "read",
      approval: "auto",
      parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
      execute(input) {
        const limit = typeof input.limit === "number" ? Math.max(1, Math.min(50, Math.trunc(input.limit))) : 10;
        return { active: store.active() ?? null, goals: store.list(limit) };
      },
    },
    {
      name: "goal_update",
      description: "Update a persistent goal's objective, priority, progress, plan, context, or lifecycle status.",
      risk: "config_write",
      approval: "required",
      parameters: {
        type: "object",
        properties: {
          goal_id: { type: "integer" },
          objective: { type: "string", maxLength: 500 },
          description: { type: "string", maxLength: 12000 },
          priority: { type: "integer", minimum: 0, maximum: 10 },
          status: { type: "string", enum: [...STATUSES] },
          status_reason: { type: "string", maxLength: 2000 },
          progress: { type: "number", minimum: 0, maximum: 1 },
          completed_steps: { type: "integer", minimum: 0 },
          total_steps: { type: "integer", minimum: 0 },
          steps: { type: "array", items: { type: "string" }, maxItems: 50 },
          context: { type: "object" },
        },
        additionalProperties: false,
      },
      execute(input) {
        const current = typeof input.goal_id === "number" ? store.get(input.goal_id) : store.active();
        if (!current) throw new Error("No matching pursue goal found.");
        const status = typeof input.status === "string" ? input.status as GoalStatus : undefined;
        if (status && !STATUSES.includes(status)) throw new Error("Invalid goal status.");
        return store.update(current.id, {
          title: typeof input.objective === "string" ? input.objective.trim() : undefined,
          description: typeof input.description === "string" ? input.description.trim() : undefined,
          priority: typeof input.priority === "number" ? input.priority : undefined,
          status,
          statusReason: typeof input.status_reason === "string" ? input.status_reason.trim() : undefined,
          progress: typeof input.progress === "number" ? input.progress : undefined,
          completedSteps: typeof input.completed_steps === "number" ? input.completed_steps : undefined,
          totalSteps: typeof input.total_steps === "number" ? input.total_steps : undefined,
          steps: Array.isArray(input.steps) ? parseSteps(input.steps) : undefined,
          context: input.context === undefined ? undefined : parseContext(input.context),
        });
      },
    },
  ];
}

/**
 * GET   /goals       -> PursueGoalSnapshot
 * POST  /goals       -> create goal, returns snapshot
 * PATCH /goals/:id   -> update goal, returns snapshot
 */
export function createGoalsRouter(store: GoalStore): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    try {
      res.json(snapshot(store));
    } catch (e: unknown) {
      res.status(500).json({ error: getErrorMessage(e) });
    }
  });

  router.post("/", (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const objective =
        typeof body["objective"] === "string" ? body["objective"].trim() : "";
      if (!objective) {
        res.status(400).json({ error: "objective is required" });
        return;
      }
      const steps = Array.isArray(body["steps"])
        ? (body["steps"] as unknown[])
            .filter((s): s is string => typeof s === "string" && s.trim() !== "")
            .map((s) => s.trim())
        : [];
      const acceptance =
        body["acceptance"] &&
        typeof body["acceptance"] === "object" &&
        !Array.isArray(body["acceptance"])
          ? (body["acceptance"] as GoalAcceptanceContract)
          : null;
      if (acceptance && (!Array.isArray(acceptance.checks) || acceptance.checks.length === 0)) {
        res.status(400).json({ error: "acceptance.checks must contain at least one deterministic check" });
        return;
      }
      const context = body["context"] && typeof body["context"] === "object" && !Array.isArray(body["context"])
        ? (body["context"] as Record<string, unknown>)
        : null;
      const priority = typeof body["priority"] === "number" && Number.isFinite(body["priority"]) ? body["priority"] : 5;
      store.create({
        title: objective,
        description:
          typeof body["description"] === "string" ? body["description"] : null,
        priority,
        context,
        steps: steps.length > 0 ? steps : DEFAULT_STEPS,
        acceptance,
        replaceExisting: body["replaceExisting"] === true,
      });
      res.status(201).json(snapshot(store));
    } catch (e: unknown) {
      res.status(500).json({ error: getErrorMessage(e) });
    }
  });

  router.patch("/:id", (req, res) => {
    try {
      const id = Number.parseInt(String(req.params["id"]), 10);
      if (!Number.isSafeInteger(id)) {
        res.status(400).json({ error: "invalid goal id" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const status = body["status"];
      if (
        status !== undefined &&
        !STATUSES.includes(status as GoalStatus)
      ) {
        res.status(400).json({ error: "invalid status" });
        return;
      }
      const num = (v: unknown) =>
        typeof v === "number" && Number.isFinite(v) ? v : undefined;
      const updated = store.update(id, {
        title: typeof body["objective"] === "string" ? body["objective"].trim() : undefined,
        description: typeof body["description"] === "string" ? body["description"] : undefined,
        priority: num(body["priority"]),
        context: body["context"] && typeof body["context"] === "object" && !Array.isArray(body["context"]) ? body["context"] as Record<string, unknown> : undefined,
        steps: Array.isArray(body["steps"]) ? (body["steps"] as unknown[]).filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()) : undefined,
        status: status as GoalStatus | undefined,
        statusReason:
          typeof body["statusReason"] === "string"
            ? body["statusReason"]
            : undefined,
        completedSteps: num(body["completedSteps"]),
        totalSteps: num(body["totalSteps"]),
        progress: num(body["progress"]),
      });
      if (!updated) {
        res.status(404).json({ error: "goal not found" });
        return;
      }
      res.json(snapshot(store));
    } catch (e: unknown) {
      res.status(500).json({ error: getErrorMessage(e) });
    }
  });

  return router;
}
