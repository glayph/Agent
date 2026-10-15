export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "retrying",
  "verifying",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["waiting_approval", "retrying", "verifying", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  retrying: ["running", "failed", "cancelled"],
  verifying: ["completed", "retrying", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
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
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function taskStatusTransitions(status: TaskStatus): readonly TaskStatus[] {
  return [...TRANSITIONS[status]];
}
