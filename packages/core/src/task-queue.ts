import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

export type AgentTaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "succeeded"
  | "failed"
  | "cancelled";
export interface TaskEnqueueOptions {
  senderIdentity?: string;
  channel?: string;
  idempotencyKey?: string;
  artifactRefs?: string[];
  priority?: number;
}
export interface AgentTask {
  id: string;
  taskId?: string;
  sessionId: string;
  message: string;
  content?: string;
  senderIdentity?: string;
  channel?: string;
  status: AgentTaskStatus;
  priority: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  retryCount: number;
  idempotencyKey?: string;
  resultSummary?: string;
  error?: string;
  artifactRefs: string[];
  checkpointId?: string;
  abortController?: AbortController;
  route?: {
    enabled: boolean;
    mode: string;
    agentId: string;
    agentName: string;
    complexity: string;
    reasons: string[];
  };
}
export interface TaskQueueConfig {
  maxSize?: number;
  defaultPriority?: number;
  enableAging?: boolean;
  agingFactorMs?: number;
  persistencePath?: string;
  databasePath?: string;
}

class BinaryHeap<T> {
  private heap: T[] = [];
  constructor(private readonly compare: (a: T, b: T) => number) {}
  get size() {
    return this.heap.length;
  }
  push(item: T) {
    this.heap.push(item);
    this.up(this.heap.length - 1);
  }
  pop() {
    if (!this.heap.length) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length && last) {
      this.heap[0] = last;
      this.down(0);
    }
    return top;
  }
  entries() {
    return [...this.heap];
  }
  removeAt(i: number) {
    if (i < 0 || i >= this.heap.length) return;
    const out = this.heap[i];
    const last = this.heap.pop();
    if (i < this.heap.length && last) {
      this.heap[i] = last;
      this.up(i);
      this.down(i);
    }
    return out;
  }
  private up(i: number) {
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.compare(this.heap[i], this.heap[p]) <= 0) break;
      [this.heap[i], this.heap[p]] = [this.heap[p], this.heap[i]];
      i = p;
    }
  }
  private down(i: number) {
    for (;;) {
      let best = i,
        l = i * 2 + 1,
        r = l + 1;
      if (
        l < this.heap.length &&
        this.compare(this.heap[l], this.heap[best]) > 0
      )
        best = l;
      if (
        r < this.heap.length &&
        this.compare(this.heap[r], this.heap[best]) > 0
      )
        best = r;
      if (best === i) return;
      [this.heap[i], this.heap[best]] = [this.heap[best], this.heap[i]];
      i = best;
    }
  }
}

type DbRow = Record<string, unknown>;
export class TaskQueue {
  private readonly tasks = new Map<string, AgentTask>();
  private readonly pending: BinaryHeap<AgentTask>;
  private readonly pendingArray: AgentTask[] = [];
  private readonly running = new Map<string, AgentTask>();
  private readonly completed = new Map<string, AgentTask>();
  private readonly db?: Database.Database;
  private readonly maxSize: number;
  private readonly defaultPriority: number;
  private readonly aging: boolean;
  private readonly agingFactorMs: number;
  private readonly jsonPath?: string;
  constructor(config: TaskQueueConfig = {}) {
    this.maxSize = config.maxSize ?? 50;
    this.defaultPriority = config.defaultPriority ?? 0;
    this.aging = config.enableAging ?? true;
    this.agingFactorMs = config.agingFactorMs ?? 10000;
    const dbPath = config.databasePath ?? config.persistencePath;
    this.jsonPath =
      !config.databasePath && config.persistencePath?.endsWith(".json")
        ? path.resolve(config.persistencePath)
        : undefined;
    if (dbPath && !dbPath.endsWith(".json")) {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
      this.db = new Database(path.resolve(dbPath));
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS task_queue (task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sender_identity TEXT, channel TEXT, message_content TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')), priority INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, result_summary TEXT, error_summary TEXT, artifact_refs TEXT NOT NULL DEFAULT '[]', checkpoint_id TEXT); CREATE INDEX IF NOT EXISTS task_queue_ready_idx ON task_queue(status, priority DESC, created_at ASC); CREATE INDEX IF NOT EXISTS task_queue_session_idx ON task_queue(session_id);`,
      );
    }
    this.pending = new BinaryHeap<AgentTask>((a, b) => this.compare(a, b));
    this.load();
  }
  enqueue(
    sessionId: string,
    message: string,
    priorityOrOptions?: number | TaskEnqueueOptions,
    legacyOptions?: TaskEnqueueOptions,
  ): AgentTask | null {
    const opts: TaskEnqueueOptions =
      typeof priorityOrOptions === "object"
        ? priorityOrOptions
        : (legacyOptions ?? { priority: priorityOrOptions });
    const key = opts.idempotencyKey?.trim() || undefined;
    if (key) {
      const existing = this.findByKey(key);
      if (existing) return existing;
    }
    if (this.tasks.size >= this.maxSize) return null;
    const task: AgentTask = {
      id: crypto.randomUUID(),
      sessionId: String(sessionId),
      message,
      content: message,
      senderIdentity: opts.senderIdentity,
      channel: opts.channel,
      status: "pending",
      priority: opts.priority ?? this.defaultPriority,
      createdAt: Date.now(),
      retryCount: 0,
      idempotencyKey: key,
      artifactRefs: opts.artifactRefs ?? [],
    };
    task.taskId = task.id;
    this.tasks.set(task.id, task);
    this.pending.push(task);
    this.pendingArray.push(task);
    this.persist(task);
    return task;
  }
  markRunning(id: string) {
    const t = this.tasks.get(id);
    if (!t || t.status !== "pending") return;
    t.status = "running";
    t.startedAt = Date.now();
    this.running.set(id, t);
    this.removePending(id);
    this.persist(t);
  }
  dequeue(): AgentTask | null {
    const t = this.pending.pop();
    if (!t) return null;
    t.status = "running";
    t.startedAt = Date.now();
    this.running.set(t.id, t);
    this.removePendingArray(t.id);
    this.persist(t);
    return t;
  }
  complete(
    id: string,
    checkpointId?: string,
    resultSummary?: string,
    artifactRefs?: string[],
  ) {
    const t = this.tasks.get(id);
    if (!t) return;
    t.status = "completed";
    t.completedAt = Date.now();
    t.checkpointId = checkpointId;
    t.resultSummary = resultSummary;
    if (artifactRefs) t.artifactRefs = artifactRefs;
    this.running.delete(id);
    this.completed.set(id, t);
    this.persist(t);
  }
  succeed(id: string, resultSummary?: string, artifactRefs?: string[]) {
    this.complete(id, undefined, resultSummary, artifactRefs);
  }
  fail(id: string, error: string) {
    const t = this.tasks.get(id);
    if (!t) return;
    t.retryCount++;
    t.error = error;
    t.status = "failed";
    t.completedAt = Date.now();
    this.running.delete(id);
    this.completed.set(id, t);
    this.persist(t);
  }
  cancel(id: string) {
    const t = this.tasks.get(id);
    if (
      !t ||
      ["completed", "succeeded", "failed", "cancelled"].includes(t.status)
    )
      return;
    t.abortController?.abort();
    t.status = "cancelled";
    t.completedAt = Date.now();
    this.running.delete(id);
    this.removePending(id);
    this.completed.set(id, t);
    this.persist(t);
  }
  getTask(id: string) {
    return this.tasks.get(id);
  }
  getPendingTasks() {
    return this.pending
      .entries()
      .sort((a, b) => this.compare(b, a) || a.createdAt - b.createdAt);
  }
  getRunningTasks() {
    return [...this.running.values()];
  }
  getCompletedTasks() {
    return [...this.completed.values()];
  }
  getTasksBySession(sessionId: string) {
    return [...this.tasks.values()].filter((t) => t.sessionId === sessionId);
  }
  getPosition(id: string) {
    const i = this.pendingArray.findIndex((t) => t.id === id);
    return i < 0 ? 0 : i + 1;
  }
  isActive() {
    return this.pending.size > 0 || this.running.size > 0;
  }
  getStats() {
    return {
      pending: this.pending.size,
      running: this.running.size,
      completed: this.completed.size,
      total: this.tasks.size,
    };
  }
  cleanup(olderThanMs: number) {
    const cutoff = Date.now() - olderThanMs;
    let n = 0;
    for (const [id, t] of this.completed)
      if ((t.completedAt ?? 0) < cutoff) {
        this.tasks.delete(id);
        this.completed.delete(id);
        this.db?.prepare("DELETE FROM task_queue WHERE task_id = ?").run(id);
        n++;
      }
    return n;
  }
  close() {
    this.db?.close();
  }
  private compare(a: AgentTask, b: AgentTask) {
    const age = (t: AgentTask) =>
      this.aging
        ? Math.floor((Date.now() - t.createdAt) / this.agingFactorMs)
        : 0;
    return a.priority + age(a) - b.priority - age(b);
  }
  private findByKey(key: string) {
    for (const t of this.tasks.values()) if (t.idempotencyKey === key) return t;
    if (!this.db) return undefined;
    const row = this.db
      .prepare("SELECT * FROM task_queue WHERE idempotency_key = ?")
      .get(key) as DbRow | undefined;
    if (!row) return undefined;
    const t = fromRow(row);
    this.tasks.set(t.id, t);
    this.index(t);
    return t;
  }
  private persist(t: AgentTask) {
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO task_queue (task_id,session_id,sender_identity,channel,message_content,created_at,started_at,completed_at,status,priority,retry_count,idempotency_key,result_summary,error_summary,artifact_refs,checkpoint_id) VALUES (@id,@sessionId,@senderIdentity,@channel,@message,@createdAt,@startedAt,@completedAt,@status,@priority,@retryCount,@idempotencyKey,@resultSummary,@error,@artifactRefs,@checkpointId) ON CONFLICT(task_id) DO UPDATE SET session_id=excluded.session_id,sender_identity=excluded.sender_identity,channel=excluded.channel,message_content=excluded.message_content,started_at=excluded.started_at,completed_at=excluded.completed_at,status=excluded.status,priority=excluded.priority,retry_count=excluded.retry_count,result_summary=excluded.result_summary,error_summary=excluded.error_summary,artifact_refs=excluded.artifact_refs,checkpoint_id=excluded.checkpoint_id`,
        )
        .run({
          id: t.id,
          sessionId: t.sessionId,
          senderIdentity: t.senderIdentity ?? null,
          channel: t.channel ?? null,
          message: t.message,
          createdAt: t.createdAt,
          startedAt: t.startedAt ?? null,
          completedAt: t.completedAt ?? null,
          status:
            t.status === "pending"
              ? "queued"
              : t.status === "completed"
                ? "succeeded"
                : t.status,
          priority: t.priority,
          retryCount: t.retryCount,
          idempotencyKey: t.idempotencyKey ?? null,
          resultSummary: t.resultSummary ?? null,
          error: t.error ?? null,
          artifactRefs: JSON.stringify(t.artifactRefs),
          checkpointId: t.checkpointId ?? null,
        });
    } else this.saveJson();
  }
  private load() {
    if (this.db) {
      for (const row of this.db
        .prepare("SELECT * FROM task_queue ORDER BY created_at ASC")
        .all() as DbRow[]) {
        const t = fromRow(row);
        if (t.status === "running") {
          t.status = "pending";
          t.startedAt = undefined;
          this.persist(t);
        }
        this.tasks.set(t.id, t);
        this.index(t);
      }
    } else if (this.jsonPath) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.jsonPath, "utf8")) as {
          tasks?: unknown[];
        };
        for (const value of parsed.tasks ?? []) {
          if (!value || typeof value !== "object") continue;
          const t = value as AgentTask;
          if (!t.id || !t.sessionId || !t.message) continue;
          if (t.status === "running") {
            t.status = "pending";
            delete t.startedAt;
          }
          t.retryCount ??= 0;
          t.artifactRefs ??= [];
          this.tasks.set(t.id, t);
          this.index(t);
        }
      } catch {
        /* missing/corrupt snapshots start empty */
      }
    }
  }
  private saveJson() {
    if (!this.jsonPath) return;
    fs.mkdirSync(path.dirname(this.jsonPath), { recursive: true });
    const tasks = [...this.tasks.values()].map(
      ({ abortController: _abortController, ...t }) => t,
    );
    fs.writeFileSync(
      this.jsonPath,
      `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`,
      "utf8",
    );
  }
  private index(t: AgentTask) {
    if (t.status === "pending" || t.status === "queued") {
      t.status = "pending";
      this.pending.push(t);
      this.pendingArray.push(t);
    } else if (t.status === "running") this.running.set(t.id, t);
    else this.completed.set(t.id, t);
  }
  private removePending(id: string) {
    this.removePendingArray(id);
    const i = this.pending.entries().findIndex((t) => t.id === id);
    if (i >= 0) this.pending.removeAt(i);
  }
  private removePendingArray(id: string) {
    const i = this.pendingArray.findIndex((t) => t.id === id);
    if (i >= 0) this.pendingArray.splice(i, 1);
  }
}
function fromRow(r: DbRow): AgentTask {
  const s = String(r.status);
  return {
    id: String(r.task_id),
    taskId: String(r.task_id),
    sessionId: String(r.session_id),
    message: String(r.message_content),
    content: String(r.message_content),
    senderIdentity:
      r.sender_identity == null ? undefined : String(r.sender_identity),
    channel: r.channel == null ? undefined : String(r.channel),
    status:
      s === "queued"
        ? "pending"
        : s === "succeeded"
          ? "completed"
          : (s as AgentTaskStatus),
    priority: Number(r.priority ?? 0),
    createdAt: Number(r.created_at),
    startedAt: r.started_at == null ? undefined : Number(r.started_at),
    completedAt: r.completed_at == null ? undefined : Number(r.completed_at),
    retryCount: Number(r.retry_count ?? 0),
    idempotencyKey:
      r.idempotency_key == null ? undefined : String(r.idempotency_key),
    resultSummary:
      r.result_summary == null ? undefined : String(r.result_summary),
    error: r.error_summary == null ? undefined : String(r.error_summary),
    artifactRefs: parseRefs(r.artifact_refs),
    checkpointId: r.checkpoint_id == null ? undefined : String(r.checkpoint_id),
  };
}
function parseRefs(v: unknown): string[] {
  try {
    const x = JSON.parse(String(v ?? "[]"));
    return Array.isArray(x) ? x.map(String) : [];
  } catch {
    return [];
  }
}
