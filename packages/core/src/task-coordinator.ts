import type Database from "better-sqlite3";
import type { CreateTaskPlanInput, CreatedTaskPlan, DurableTaskStore, TaskTreeNode } from "./task-store.js";

export type TaskLineageSource = "foreground_run" | "background_job" | "autonomy_schedule" | "system";

export interface TaskCoordinatorSnapshot {
  durableTasks: Record<string, number>;
  scheduledTasks: Record<string, number>;
  lineageLinks: number;
  missingDurableTasks: number;
  unlinkedScheduledTasks: number;
  sampledAt: string;
}

/**
 * Connects foreground runs, background jobs and recurring autonomy schedules
 * to the canonical durable execution records in miki_tasks. Schedule rows are
 * definitions/occurrences; miki_tasks remains the source of truth for an
 * executable task's lease, checkpoint, result and terminal state.
 */
export class UnifiedTaskCoordinator {
  constructor(
    private readonly db: Database.Database,
    private readonly durableTasks: DurableTaskStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS miki_task_lineage (
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        durable_task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(source, source_id),
        UNIQUE(source, durable_task_id),
        FOREIGN KEY(durable_task_id) REFERENCES miki_tasks(task_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_miki_task_lineage_durable
        ON miki_task_lineage(durable_task_id);
    `);
  }

  link(source: TaskLineageSource, sourceId: string, durableTaskId: string): void {
    const normalizedSourceId = sourceId.trim().slice(0, 240);
    if (!normalizedSourceId || !durableTaskId.trim()) throw new Error("Task lineage requires non-empty source and durable task IDs.");
    if (!this.durableTasks.get(durableTaskId)) throw new Error(`Cannot link missing durable task ${durableTaskId}.`);
    const timestamp = this.now();
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT durable_task_id FROM miki_task_lineage WHERE source=? AND source_id=?").get(source, normalizedSourceId) as { durable_task_id: string } | undefined;
      if (existing && existing.durable_task_id !== durableTaskId) {
        throw new Error(`Task lineage ${source}/${normalizedSourceId} is already bound to a different durable task.`);
      }
      const durableOwner = this.db.prepare("SELECT source,source_id FROM miki_task_lineage WHERE source=? AND durable_task_id=?").get(source, durableTaskId) as { source: string; source_id: string } | undefined;
      if (durableOwner && durableOwner.source_id !== normalizedSourceId) {
        throw new Error(`Durable task ${durableTaskId} is already linked to ${source}/${durableOwner.source_id}.`);
      }
      this.db.prepare(`INSERT INTO miki_task_lineage(source,source_id,durable_task_id,created_at,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(source,source_id) DO UPDATE SET updated_at=excluded.updated_at`).run(
        source, normalizedSourceId, durableTaskId, timestamp, timestamp,
      );
    });
    tx.immediate();
  }

  /**
   * Applies a scheduled execution's mirrored lifecycle to the canonical miki_tasks
   * record. The schedule table retains recurrence/trigger metadata, while all
   * execution transitions are performed through DurableTaskStore here.
   */
  mirrorAutonomyScheduleExecution(input: {
    scheduleTaskId: number;
    durableTaskId: string;
    title: string;
    status: "running" | "queued" | "completed" | "failed";
    result?: string;
    error?: string;
    now?: string;
  }): void {
    const timestamp = input.now ?? this.now();
    const durableTaskId = input.durableTaskId.trim();
    if (!Number.isSafeInteger(input.scheduleTaskId) || input.scheduleTaskId < 1 || !durableTaskId) {
      throw new Error("A scheduled execution requires a valid schedule ID and durable task ID.");
    }
    if (this.tableExists("autonomy_task_queue")) {
      const updated = this.db.prepare("UPDATE autonomy_task_queue SET durable_task_id=? WHERE task_id=?")
        .run(durableTaskId, input.scheduleTaskId);
      if (updated.changes === 0) throw new Error(`Scheduled task ${input.scheduleTaskId} no longer exists.`);
    }
    let current = this.durableTasks.get(durableTaskId);
    if (!current) {
      this.durableTasks.create({ taskId: durableTaskId, goal: input.title, now: timestamp });
      current = this.durableTasks.get(durableTaskId);
    }
    if (!current) throw new Error(`Durable autonomy task ${durableTaskId} could not be loaded after creation.`);
    this.link("autonomy_schedule", `${input.scheduleTaskId}:${durableTaskId}`, durableTaskId);

    if (input.status === "running") {
      if (current.status === "queued" || current.status === "retrying") {
        this.durableTasks.transition(durableTaskId, "running", { now: timestamp, leaseMs: 300_000, reason: "autonomous supervisor claimed task" });
      } else if (current.status === "running") {
        this.durableTasks.renewLease(durableTaskId, timestamp, 300_000);
      }
      return;
    }
    if (input.status === "queued") {
      if (current.status === "running") {
        this.durableTasks.transition(durableTaskId, "retrying", { now: timestamp, reason: input.error ?? "autonomous task queued for retry", error: input.error });
      }
      return;
    }
    if (input.status === "completed") {
      if (current.status === "queued" || current.status === "retrying") {
        this.durableTasks.transition(durableTaskId, "running", { now: timestamp, leaseMs: 300_000, reason: "autonomous task completion recovered from mirror outbox" });
      }
      const running = this.durableTasks.get(durableTaskId);
      if (running?.status === "running") this.durableTasks.transition(durableTaskId, "verifying", { now: timestamp, reason: "autonomous result ready for verification", result: input.result });
      const verifying = this.durableTasks.get(durableTaskId);
      if (verifying?.status === "verifying") this.durableTasks.transition(durableTaskId, "completed", { now: timestamp, reason: "autonomous acceptance completed", result: input.result });
      return;
    }
    if (current.status === "queued") {
      this.durableTasks.transition(durableTaskId, "running", { now: timestamp, leaseMs: 300_000, reason: "autonomous failure recorded" });
    }
    const latest = this.durableTasks.get(durableTaskId);
    if (latest?.status === "running" || latest?.status === "retrying") {
      this.durableTasks.transition(durableTaskId, "failed", { now: timestamp, reason: input.error ?? "autonomous task failed", error: input.error });
    }
  }

  /** Rebuilds missing lineage links for schedule rows without changing task states. */
  reconcileAutonomySchedules(): { linked: number; missingDurableTasks: number; skipped: number } {
    if (!this.tableExists("autonomy_task_queue")) return { linked: 0, missingDurableTasks: 0, skipped: 0 };
    const rows = this.db.prepare(`SELECT q.task_id,q.durable_task_id FROM autonomy_task_queue q
      LEFT JOIN miki_task_lineage l ON l.source='autonomy_schedule'
        AND l.source_id=(CAST(q.task_id AS TEXT) || ':' || q.durable_task_id)
      WHERE q.status IN ('queued','running') AND q.durable_task_id IS NOT NULL AND l.durable_task_id IS NULL
      ORDER BY q.task_id ASC`).all() as Array<{ task_id: number; durable_task_id: string }>;
    let linked = 0;
    let missingDurableTasks = 0;
    let skipped = 0;
    for (const row of rows) {
      const durable = this.durableTasks.get(row.durable_task_id);
      if (!durable) { missingDurableTasks += 1; continue; }
      try {
        this.link("autonomy_schedule", `${row.task_id}:${row.durable_task_id}`, row.durable_task_id);
        linked += 1;
      } catch {
        skipped += 1;
      }
    }
    return { linked, missingDurableTasks, skipped };
  }

  /** Create a durable dependency-aware goal and child-task graph. */
  createPlan(input: CreateTaskPlanInput): CreatedTaskPlan {
    return this.durableTasks.createPlan(input);
  }

  /** Expose the persisted parent/child graph, dependency gates and current states. */
  getTaskTree(taskId: string): TaskTreeNode | null {
    return this.durableTasks.getTaskTree(taskId);
  }

  /** Atomically revise an active goal plan and rewire its durable dependencies. */
  replan(parentTaskId: string, input: import("./task-store.js").ReplanTaskPlanInput, now = this.now()) {
    return this.durableTasks.replan(parentTaskId, input, now);
  }

  /** Reconcile dependency blockers and aggregate parent progress after restart. */
  reconcile(now = this.now()): { blockedDependents: number; updatedParents: number } {
    return this.durableTasks.reconcileHierarchy(now);
  }

  snapshot(): TaskCoordinatorSnapshot {
    const durableRows = this.db.prepare("SELECT status,COUNT(*) AS count FROM miki_tasks GROUP BY status").all() as Array<{ status: string; count: number }>;
    const scheduledRows = this.tableExists("autonomy_task_queue")
      ? this.db.prepare("SELECT status,COUNT(*) AS count FROM autonomy_task_queue GROUP BY status").all() as Array<{ status: string; count: number }>
      : [];
    const lineageLinks = Number((this.db.prepare("SELECT COUNT(*) AS count FROM miki_task_lineage").get() as { count: number }).count);
    const missingDurableTasks = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM miki_task_lineage l
      LEFT JOIN miki_tasks t ON t.task_id=l.durable_task_id WHERE t.task_id IS NULL`).get() as { count: number }).count);
    let unlinkedScheduledTasks = 0;
    if (this.tableExists("autonomy_task_queue")) {
      unlinkedScheduledTasks = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM autonomy_task_queue q
        LEFT JOIN miki_task_lineage l ON l.source='autonomy_schedule'
          AND l.source_id=(CAST(q.task_id AS TEXT) || ':' || q.durable_task_id)
        WHERE q.status IN ('queued','running') AND q.durable_task_id IS NOT NULL AND l.durable_task_id IS NULL`).get() as { count: number }).count);
    }
    return {
      durableTasks: Object.fromEntries(durableRows.map((row) => [row.status, row.count])),
      scheduledTasks: Object.fromEntries(scheduledRows.map((row) => [row.status, row.count])),
      lineageLinks,
      missingDurableTasks,
      unlinkedScheduledTasks,
      sampledAt: this.now(),
    };
  }

  private tableExists(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }
}
