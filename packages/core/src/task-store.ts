import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  transitionTask,
  type TaskLifecycle,
  type TaskStatus,
} from "./task-state.js";

export interface CreateTaskInput {
  taskId?: string;
  goal: string;
  sessionId?: string;
  now?: string;
}

export interface DurableTask extends TaskLifecycle {
  goal: string;
  createdAt: string;
  sessionId?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  result?: string;
}

export interface TaskTransitionEvent {
  id: number;
  taskId: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus;
  version: number;
  reason?: string;
  createdAt: string;
}

interface TaskRow {
  task_id: string;
  goal: string;
  session_id: string | null;
  status: TaskStatus;
  version: number;
  lease_expires_at: string | null;
  last_error: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  task_id: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus;
  version: number;
  reason: string | null;
  created_at: string;
}

export class DurableTaskStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS miki_tasks (
        task_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        lease_expires_at TEXT,
        last_error TEXT,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_miki_tasks_claim
        ON miki_tasks(status, lease_expires_at, updated_at);
      CREATE TABLE IF NOT EXISTS miki_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        version INTEGER NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES miki_tasks(task_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_miki_task_events_task
        ON miki_task_events(task_id, id);
    `);
  }

  create(input: CreateTaskInput): DurableTask {
    const taskId = input.taskId ?? randomUUID();
    const timestamp = input.now ?? this.now();
    const task: DurableTask = {
      taskId,
      goal: input.goal,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      status: "queued",
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const insert = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO miki_tasks(task_id,goal,session_id,status,version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)
      `).run(task.taskId, task.goal, task.sessionId ?? null, task.status, task.version, timestamp, timestamp);
      this.db.prepare(`
        INSERT INTO miki_task_events(task_id,from_status,to_status,version,reason,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(task.taskId, null, task.status, task.version, "task created", timestamp);
    });
    insert();
    return { ...task };
  }

  get(taskId: string): DurableTask | null {
    const row = this.db.prepare("SELECT * FROM miki_tasks WHERE task_id=?").get(taskId) as TaskRow | undefined;
    return row ? this.toTask(row) : null;
  }

  listEvents(taskId: string): TaskTransitionEvent[] {
    const rows = this.db.prepare("SELECT * FROM miki_task_events WHERE task_id=? ORDER BY id ASC").all(taskId) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      version: row.version,
      ...(row.reason ? { reason: row.reason } : {}),
      createdAt: row.created_at,
    }));
  }

  transition(
    taskId: string,
    nextStatus: TaskStatus,
    options: { now?: string; reason?: string; leaseMs?: number; result?: string; error?: string } = {},
  ): DurableTask {
    const update = this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error(`Task not found: ${taskId}`);
      const timestamp = options.now ?? this.now();
      const next = transitionTask(current, nextStatus, {
        now: timestamp,
        ...(options.reason ? { reason: options.reason } : {}),
      });
      const leaseExpiresAt = next.status === "running" && options.leaseMs !== undefined
        ? new Date(Date.parse(timestamp) + Math.max(0, options.leaseMs)).toISOString()
        : null;
      const result = this.db.prepare(`
        UPDATE miki_tasks
        SET status=?,version=?,lease_expires_at=?,last_error=?,result=?,updated_at=?
        WHERE task_id=? AND version=?
      `).run(
        next.status,
        next.version,
        leaseExpiresAt,
        options.error ?? (next.status === "failed" ? (next.reason ?? null) : current.lastError ?? null),
        options.result ?? current.result ?? null,
        timestamp,
        taskId,
        current.version,
      );
      if (result.changes !== 1) throw new Error(`Task version conflict: ${taskId}`);
      this.db.prepare(`
        INSERT INTO miki_task_events(task_id,from_status,to_status,version,reason,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(taskId, current.status, next.status, next.version, next.reason ?? null, timestamp);
      return this.get(taskId)!;
    });
    return update();
  }

  claimNext(now = this.now(), leaseMs = 60_000): DurableTask | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM miki_tasks
        WHERE status IN ('queued','retrying')
        ORDER BY updated_at ASC
        LIMIT 1
      `).get() as TaskRow | undefined;
      if (!row) return null;
      return this.transition(row.task_id, "running", {
        now,
        leaseMs,
        reason: "worker claimed task",
      });
    });
    return claim();
  }

  renewLease(taskId: string, now = this.now(), leaseMs = 60_000): boolean {
    const leaseExpiresAt = new Date(Date.parse(now) + Math.max(0, leaseMs)).toISOString();
    return this.db.prepare(`
      UPDATE miki_tasks
      SET lease_expires_at=?,updated_at=?
      WHERE task_id=? AND status='running'
    `).run(leaseExpiresAt, now, taskId).changes === 1;
  }

  recoverExpired(now = this.now()): DurableTask[] {
    const rows = this.db.prepare(`
      SELECT task_id FROM miki_tasks
      WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?
      ORDER BY updated_at ASC
    `).all(now) as Array<{ task_id: string }>;
    return rows.map((row) => this.transition(row.task_id, "retrying", {
      now,
      reason: "worker lease expired; task requeued",
    }));
  }

  private toTask(row: TaskRow): DurableTask {
    return {
      taskId: row.task_id,
      goal: row.goal,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      status: row.status,
      version: row.version,
      createdAt: row.created_at,
      ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      ...(row.result ? { result: row.result } : {}),
      updatedAt: row.updated_at,
    };
  }
}
