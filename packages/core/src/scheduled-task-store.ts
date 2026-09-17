import Database from "better-sqlite3";
import type { ScheduledTask, ScheduledTaskStore } from "./scheduler.js";

interface ScheduledTaskRow {
  id: string;
  session_id: string;
  message: string;
  cron_expression: string | null;
  run_at: number | null;
  status: ScheduledTask["status"];
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  completed_at: number | null;
}

export class SqliteScheduledTaskStore implements ScheduledTaskStore {
  constructor(private db: Database.Database) {
    this.ensureSchema();
  }

  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_scheduled_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message TEXT NOT NULL,
        cron_expression TEXT,
        run_at INTEGER,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_at INTEGER,
        completed_at INTEGER
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_scheduled_tasks_active
      ON agent_scheduled_tasks(status, run_at)
    `);
  }

  loadActiveTasks(): ScheduledTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_scheduled_tasks
         WHERE status IN ('pending', 'running')
         ORDER BY run_at ASC, created_at ASC`,
      )
      .all() as ScheduledTaskRow[];
    return rows.map((row) => this._fromRow(row));
  }

  loadRecentTasks(limit: number = 100): ScheduledTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_scheduled_tasks
         ORDER BY updated_at DESC, created_at DESC
         LIMIT ?`,
      )
      .all(limit) as ScheduledTaskRow[];
    return rows.map((row) => this._fromRow(row));
  }

  loadTask(id: string): ScheduledTask | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_scheduled_tasks WHERE id = ?")
      .get(id) as ScheduledTaskRow | undefined;
    return row ? this._fromRow(row) : undefined;
  }

  upsertTask(task: ScheduledTask): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agent_scheduled_tasks
         (id, session_id, message, cron_expression, run_at, status, attempts,
          max_attempts, last_error, created_at, updated_at, last_run_at,
          completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.sessionId,
        task.message,
        task.cronExpression ?? null,
        task.runAt ?? null,
        task.status,
        task.attempts,
        task.maxAttempts,
        task.lastError ?? null,
        task.createdAt,
        task.updatedAt,
        task.lastRunAt ?? null,
        task.completedAt ?? null,
      );
  }

  private _fromRow(row: ScheduledTaskRow): ScheduledTask {
    return {
      id: row.id,
      sessionId: row.session_id,
      message: row.message,
      cronExpression: row.cron_expression ?? undefined,
      runAt: row.run_at ?? undefined,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRunAt: row.last_run_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
    };
  }
}
