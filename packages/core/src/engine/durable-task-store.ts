import type Database from "better-sqlite3";

export type DurableTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "limit_reached";

type TaskRow = {
  task_id: string;
  goal: string;
  session_id: string | null;
  status: DurableTaskStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  lease_expires_at: string | null;
  result: string | null;
  error: string | null;
  reason: string | null;
};

export class DurableTaskStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS durable_tasks (
        task_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        lease_expires_at TEXT,
        result TEXT,
        error TEXT,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_durable_tasks_status ON durable_tasks(status, created_at DESC);
    `);
  }

  create(input: { taskId: string; goal: string; sessionId?: string; now?: string }): void {
    this.db.prepare(`INSERT OR IGNORE INTO durable_tasks(task_id, goal, session_id, status, created_at) VALUES (?, ?, ?, 'queued', ?)`).run(
      input.taskId, input.goal, input.sessionId ?? null, input.now ?? this.now(),
    );
  }

  transition(taskId: string, status: DurableTaskStatus, input: { now?: string; leaseMs?: number; result?: string; error?: string; reason?: string } = {}): void {
    const at = input.now ?? this.now();
    const lease = input.leaseMs && input.leaseMs > 0 ? new Date(Date.parse(at) + input.leaseMs).toISOString() : null;
    this.db.prepare(`UPDATE durable_tasks SET status = ?, started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END, finished_at = CASE WHEN ? IN ('completed','failed','cancelled','limit_reached') THEN ? ELSE finished_at END, lease_expires_at = ?, result = COALESCE(?, result), error = COALESCE(?, error), reason = COALESCE(?, reason) WHERE task_id = ?`).run(
      status, status, at, status, at, lease, input.result ?? null, input.error ?? null, input.reason ?? null, taskId,
    );
  }

  recoverExpired(at = this.now()): number {
    const result = this.db.prepare(`UPDATE durable_tasks SET status = 'failed', finished_at = ?, error = COALESCE(error, 'Task lease expired.'), reason = COALESCE(reason, 'recovered expired lease') WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`).run(at, at);
    return result.changes;
  }

  get(taskId: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM durable_tasks WHERE task_id = ?").get(taskId) as TaskRow | undefined;
  }
}
