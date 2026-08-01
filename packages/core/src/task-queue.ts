import * as crypto from "crypto";

export interface AgentTask {
  id: string;
  sessionId: string;
  message: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  priority: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
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
}

class BinaryHeap<T> {
  private _heap: T[] = [];
  private _compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this._compare = compare;
  }

  get size(): number {
    return this._heap.length;
  }

  isEmpty(): boolean {
    return this._heap.length === 0;
  }

  push(item: T): void {
    this._heap.push(item);
    this._bubbleUp(this._heap.length - 1);
  }

  pop(): T | undefined {
    if (this._heap.length === 0) return undefined;
    const top = this._heap[0];
    const last = this._heap.pop();
    if (this._heap.length > 0 && last !== undefined) {
      this._heap[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  peek(): T | undefined {
    return this._heap[0];
  }

  entries(): T[] {
    return [...this._heap];
  }

  removeAt(index: number): T | undefined {
    if (index < 0 || index >= this._heap.length) return undefined;
    const removed = this._heap[index];
    const last = this._heap.pop();
    if (index < this._heap.length && last !== undefined) {
      this._heap[index] = last;
      this._bubbleUp(index);
      this._sinkDown(index);
    }
    return removed;
  }

  private _bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this._compare(this._heap[index], this._heap[parent]) <= 0) break;
      [this._heap[index], this._heap[parent]] = [
        this._heap[parent],
        this._heap[index],
      ];
      index = parent;
    }
  }

  private _sinkDown(index: number): void {
    const length = this._heap.length;
    while (true) {
      let largest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      if (
        left < length &&
        this._compare(this._heap[left], this._heap[largest]) > 0
      ) {
        largest = left;
      }
      if (
        right < length &&
        this._compare(this._heap[right], this._heap[largest]) > 0
      ) {
        largest = right;
      }
      if (largest === index) break;
      [this._heap[index], this._heap[largest]] = [
        this._heap[largest],
        this._heap[index],
      ];
      index = largest;
    }
  }
}

export class TaskQueue {
  private _tasks: Map<string, AgentTask> = new Map();
  private _pending: BinaryHeap<AgentTask>;
  private _pendingIndex: Map<string, number> = new Map();
  private _pendingArray: AgentTask[] = [];
  private _running: Map<string, AgentTask> = new Map();
  private _completed: Map<string, AgentTask> = new Map();
  private _maxSize: number;
  private _defaultPriority: number;
  private _enableAging: boolean;
  private _agingFactorMs: number;

  constructor(config: TaskQueueConfig = {}) {
    this._maxSize = config.maxSize ?? 50;
    this._defaultPriority = config.defaultPriority ?? 0;
    this._enableAging = config.enableAging ?? true;
    this._agingFactorMs = config.agingFactorMs ?? 10000;
    this._pending = new BinaryHeap<AgentTask>(this._compareTasks.bind(this));
  }

  private _effectivePriority(task: AgentTask): number {
    if (!this._enableAging) return task.priority;
    const age = Date.now() - task.createdAt;
    return task.priority + Math.floor(age / this._agingFactorMs);
  }

  private _compareTasks(a: AgentTask, b: AgentTask): number {
    return this._effectivePriority(a) - this._effectivePriority(b);
  }

  enqueue(
    sessionId: string,
    message: string,
    priority?: number,
  ): AgentTask | null {
    if (this._tasks.size >= this._maxSize) {
      return null;
    }
    const task: AgentTask = {
      id: crypto.randomUUID(),
      sessionId,
      message,
      status: "pending",
      priority: priority ?? this._defaultPriority,
      createdAt: Date.now(),
    };

    this._tasks.set(task.id, task);
    this._pending.push(task);
    this._pendingArray.push(task);
    this._syncPendingIndex();
    return task;
  }

  markRunning(taskId: string): void {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "pending") return;

    task.status = "running";
    task.startedAt = Date.now();
    this._running.set(taskId, task);
    this._removeFromPending(taskId);
  }

  dequeue(): AgentTask | null {
    if (this._pending.size === 0) {
      return null;
    }
    const task = this._pending.pop();
    if (!task) return null;

    task.status = "running";
    task.startedAt = Date.now();
    this._running.set(task.id, task);
    this._tasks.set(task.id, task);
    this._removeFromPendingArray(task.id);
    this._syncPendingIndex();
    return task;
  }

  complete(taskId: string, checkpointId?: string): void {
    const task = this._tasks.get(taskId);
    if (!task) return;

    task.status = "completed";
    task.completedAt = Date.now();
    task.checkpointId = checkpointId;
    this._running.delete(taskId);
    this._completed.set(taskId, task);
  }

  fail(taskId: string, error: string): void {
    const task = this._tasks.get(taskId);
    if (!task) return;

    task.status = "failed";
    task.error = error;
    task.completedAt = Date.now();
    this._running.delete(taskId);
    this._completed.set(taskId, task);
  }

  cancel(taskId: string): void {
    const task = this._tasks.get(taskId);
    if (!task) return;

    if (task.status === "pending") {
      this._removeFromPending(taskId);
      this._removeFromPendingArray(taskId);
      task.status = "cancelled";
      task.completedAt = Date.now();
      this._completed.set(taskId, task);
    } else if (task.status === "running") {
      task.abortController?.abort();
      task.status = "cancelled";
      task.completedAt = Date.now();
      this._running.delete(taskId);
      this._completed.set(taskId, task);
    }
  }

  getTask(taskId: string): AgentTask | undefined {
    return this._tasks.get(taskId);
  }

  getPendingTasks(): AgentTask[] {
    return this._pending
      .entries()
      .sort((a, b) => this._compareTasks(b, a) || a.createdAt - b.createdAt);
  }

  getRunningTasks(): AgentTask[] {
    return [...this._running.values()];
  }

  getCompletedTasks(): AgentTask[] {
    return [...this._completed.values()];
  }

  getTasksBySession(sessionId: string): AgentTask[] {
    return [...this._tasks.values()].filter((t) => t.sessionId === sessionId);
  }

  getPosition(taskId: string): number {
    // Position tracking is approximate with heap; return the index in the raw pending array
    const idx = this._pendingArray.findIndex((t) => t.id === taskId);
    return idx >= 0 ? idx + 1 : 0;
  }

  isActive(): boolean {
    return this._running.size > 0 || this._pending.size > 0;
  }

  getStats(): {
    pending: number;
    running: number;
    completed: number;
    total: number;
  } {
    return {
      pending: this._pending.size,
      running: this._running.size,
      completed: this._completed.size,
      total: this._tasks.size,
    };
  }

  cleanup(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;

    for (const [id, task] of this._completed.entries()) {
      if ((task.completedAt ?? 0) < cutoff) {
        this._completed.delete(id);
        this._tasks.delete(id);
        removed++;
      }
    }

    return removed;
  }

  private _syncPendingIndex(): void {
    this._pendingIndex.clear();
    const entries = this._pending.entries();
    for (let i = 0; i < entries.length; i++) {
      this._pendingIndex.set(entries[i].id, i);
    }
  }

  private _removeFromPending(taskId: string): void {
    const index = this._pendingIndex.get(taskId);
    if (index !== undefined) {
      this._pending.removeAt(index);
      this._syncPendingIndex();
    }
    this._removeFromPendingArray(taskId);
  }

  private _removeFromPendingArray(taskId: string): void {
    const idx = this._pendingArray.findIndex((t) => t.id === taskId);
    if (idx >= 0) {
      this._pendingArray.splice(idx, 1);
    }
  }
}
