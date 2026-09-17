import Database from "better-sqlite3";
import type { Objective, ObjectiveStatus, PlanStep } from "./types.js";

interface ObjectiveRow {
  id: string;
  type: string;
  status: ObjectiveStatus;
  title: string;
  rationale: string;
  created_at: number;
  updated_at: number;
  priority: number;
  progress: number;
  plan: string;
  context: string;
  result: string | null;
  replans: number;
  session_id: string | null;
  active_task_id: string | null;
}

/**
 * Durable storage for autonomous objectives, mirroring the conventions of
 * SqliteScheduledTaskStore / SqliteAutomationStore elsewhere in this
 * package: a plain `better-sqlite3` handle is injected so the caller
 * controls the db file location and lifecycle.
 */
export class SqliteObjectiveStore {
  constructor(private db: Database.Database) {
    this.ensureSchema();
  }

  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_objectives (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        priority REAL NOT NULL DEFAULT 0,
        progress REAL NOT NULL DEFAULT 0,
        plan TEXT NOT NULL DEFAULT '[]',
        context TEXT NOT NULL DEFAULT '{}',
        result TEXT,
        replans INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        active_task_id TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_autonomy_objectives_status
      ON autonomy_objectives(status, updated_at)
    `);
  }

  create(objective: Objective): void {
    this._upsert(objective);
  }

  update(objective: Objective): void {
    this._upsert(objective);
  }

  get(id: string): Objective | undefined {
    const row = this.db
      .prepare("SELECT * FROM autonomy_objectives WHERE id = ?")
      .get(id) as ObjectiveRow | undefined;
    return row ? this._fromRow(row) : undefined;
  }

  /** Objectives that are not yet finished — the first thing resumed on restart. */
  listUnfinished(): Objective[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM autonomy_objectives
         WHERE status IN ('pending', 'in_progress', 'blocked')
         ORDER BY priority DESC, updated_at ASC`,
      )
      .all() as ObjectiveRow[];
    return rows.map((r) => this._fromRow(r));
  }

  listRecent(limit = 50): Objective[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM autonomy_objectives
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as ObjectiveRow[];
    return rows.map((r) => this._fromRow(r));
  }

  countByStatus(status: ObjectiveStatus): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM autonomy_objectives WHERE status = ?")
      .get(status) as { n: number };
    return row?.n ?? 0;
  }

  private _upsert(o: Objective): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO autonomy_objectives
         (id, type, status, title, rationale, created_at, updated_at,
          priority, progress, plan, context, result, replans, session_id,
          active_task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.id,
        String(o.type),
        o.status,
        o.title,
        o.rationale,
        o.createdAt,
        o.updatedAt,
        o.priority,
        o.progress,
        JSON.stringify(o.plan ?? []),
        JSON.stringify(o.context ?? {}),
        o.result == null ? null : JSON.stringify(o.result),
        o.replans ?? 0,
        o.sessionId ?? null,
        o.activeTaskId ?? null,
      );
  }

  private _fromRow(row: ObjectiveRow): Objective {
    let plan: PlanStep[] = [];
    let context: Record<string, unknown> = {};
    let result: Objective["result"] = null;
    try {
      plan = JSON.parse(row.plan) as PlanStep[];
    } catch {
      plan = [];
    }
    try {
      context = JSON.parse(row.context) as Record<string, unknown>;
    } catch {
      context = {};
    }
    if (row.result != null) {
      try {
        result = JSON.parse(row.result) as Record<string, unknown>;
      } catch {
        result = row.result;
      }
    }
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      title: row.title,
      rationale: row.rationale,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      priority: row.priority,
      progress: row.progress,
      plan,
      context,
      result,
      replans: row.replans,
      sessionId: row.session_id ?? undefined,
      activeTaskId: row.active_task_id ?? undefined,
    };
  }
}
