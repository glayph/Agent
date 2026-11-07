export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "retrying",
  "verifying",
  "needs_reconciliation",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "superseded",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "blocked", "cancelled", "superseded"],
  running: ["waiting_approval", "retrying", "verifying", "needs_reconciliation", "blocked", "failed", "cancelled"],
  waiting_approval: ["running", "queued", "blocked", "failed", "cancelled"],
  retrying: ["running", "blocked", "needs_reconciliation", "failed", "cancelled", "superseded"],
  verifying: ["completed", "retrying", "needs_reconciliation", "blocked", "failed", "cancelled"],
  needs_reconciliation: ["queued", "running", "verifying", "blocked", "failed", "cancelled"],
  blocked: ["queued", "running", "needs_reconciliation", "failed", "cancelled", "superseded"],
  completed: [],
  // Owner-approved retry is allowed after the failure cause has been corrected.
  failed: ["queued", "superseded"],
  cancelled: [],
  superseded: [],
};

export interface TaskLifecycle {
  taskId: string;
  status: TaskStatus;
  version: number;
  updatedAt: string;
  reason?: string;
}

export class InvalidTaskTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid task state transition: ${from} -> ${to}.`);
    this.name = "InvalidTaskTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionTask(
  task: TaskLifecycle,
  next: TaskStatus,
  options: { now?: string; reason?: string } = {},
): TaskLifecycle {
  if (!canTransitionTaskStatus(task.status, next)) {
    throw new InvalidTaskTransitionError(task.status, next);
  }
  return {
    taskId: task.taskId,
    status: next,
    version: task.version + 1,
    updatedAt: options.now ?? new Date().toISOString(),
    ...(options.reason ? { reason: options.reason } : {}),
  };
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "superseded";
}

export function isRunnableTaskStatus(status: TaskStatus): boolean {
  return status === "queued" || status === "retrying";
}

export function taskStatusTransitions(status: TaskStatus): readonly TaskStatus[] {
  return [...TRANSITIONS[status]];
}
