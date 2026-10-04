import Database from "better-sqlite3";
import { Router } from "express";

import { getErrorMessage } from "../errors.js";

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
        last_pursued_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
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
    steps: string[];
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
             (title, description, status, total_steps, steps, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'dashboard', ?, ?)`,
        )
        .run(
          input.title,
          input.description ?? null,
          hasActive ? "pending" : "active",
          input.steps.length,
          JSON.stringify(input.steps),
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
      status?: GoalStatus;
      statusReason?: string;
      completedSteps?: number;
      totalSteps?: number;
      progress?: number;
    },
  ): GoalDbRow | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const total = patch.totalSteps ?? current.total_steps;
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
            SET status = ?, status_reason = ?, progress = ?, total_steps = ?,
                completed_steps = ?, updated_at = ?, last_pursued_at = ?
          WHERE id = ?`,
      )
      .run(
        status,
        patch.statusReason ?? current.status_reason,
        Math.max(0, Math.min(1, progress)),
        total,
        completed,
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
      store.create({
        title: objective,
        description:
          typeof body["description"] === "string" ? body["description"] : null,
        steps: steps.length > 0 ? steps : DEFAULT_STEPS,
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
