import Database from "better-sqlite3";
import type { ScheduledTask, ScheduledTaskStore } from "./scheduler.js";

interface ScheduledTaskRow {
  id: string;
  session_id: string;
  message: string;
  cron_expression: string | null;
  interval_ms: number | null;
  timezone: string | null;
  missed_run_policy: ScheduledTask["missedRunPolicy"] | null;
  timeout_ms: number | null;
  quiet_hours: string | null;
  concurrency_limit: number | null;
  execution_token: string | null;
  title: string | null;
  result_summary: string | null;
  artifact_refs: string | null;
  notification_sent_at: number | null;
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
    for (const column of [
      ["interval_ms", "INTEGER"],
      ["timezone", "TEXT"],
      ["missed_run_policy", "TEXT"],
      ["timeout_ms", "INTEGER"],
      ["quiet_hours", "TEXT"],
      ["concurrency_limit", "INTEGER"],
      ["execution_token", "TEXT"],
      ["title", "TEXT"],
      ["result_summary", "TEXT"],
      ["artifact_refs", "TEXT"],
      ["notification_sent_at", "INTEGER"],
    ] as const) {
      try {
        this.db.exec(
          `ALTER TABLE agent_scheduled_tasks ADD COLUMN ${column[0]} ${column[1]}`,
        );
      } catch {
        /* already migrated */
      }
    }
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
         (id, session_id, message, cron_expression, interval_ms, timezone,
          missed_run_policy, timeout_ms, quiet_hours, concurrency_limit,
          execution_token, run_at, status, attempts, max_attempts, last_error,
          title, result_summary, artifact_refs, notification_sent_at,
          created_at, updated_at, last_run_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.sessionId,
        task.message,
        task.cronExpression ?? null,
        task.intervalMs ?? null,
        task.timezone ?? null,
        task.missedRunPolicy ?? null,
        task.timeoutMs ?? null,
        task.quietHours ? JSON.stringify(task.quietHours) : null,
        task.concurrencyLimit ?? null,
        task.executionToken ?? null,
        task.runAt ?? null,
        task.status,
        task.attempts,
        task.maxAttempts,
        task.lastError ?? null,
        task.title ?? null,
        task.resultSummary ?? null,
        JSON.stringify(task.artifactRefs ?? []),
        task.notificationSentAt ?? null,
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
      intervalMs: row.interval_ms ?? undefined,
      timezone: row.timezone ?? undefined,
      missedRunPolicy: row.missed_run_policy ?? undefined,
      timeoutMs: row.timeout_ms ?? undefined,
      quietHours: row.quiet_hours ? JSON.parse(row.quiet_hours) : undefined,
      concurrencyLimit: row.concurrency_limit ?? undefined,
      executionToken: row.execution_token ?? undefined,
      title: row.title ?? undefined,
      resultSummary: row.result_summary ?? undefined,
      artifactRefs: row.artifact_refs ? JSON.parse(row.artifact_refs) : [],
      notificationSentAt: row.notification_sent_at ?? undefined,
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
