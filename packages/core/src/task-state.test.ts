import {
  InvalidTaskTransitionError,
  canTransitionTaskStatus,
  isTerminalTaskStatus,
  taskStatusTransitions,
  transitionTask,
  type TaskLifecycle,
} from "./task-state.js";

const task = (status: TaskLifecycle["status"] = "queued"): TaskLifecycle => ({
  taskId: "task-1",
  status,
  version: 3,
  updatedAt: "2026-10-15T00:00:00.000Z",
});

describe("task lifecycle state machine", () => {
  it("allows the planned execution and verification path", () => {
    expect(canTransitionTaskStatus("queued", "running")).toBe(true);
    expect(canTransitionTaskStatus("running", "waiting_approval")).toBe(true);
    expect(canTransitionTaskStatus("waiting_approval", "running")).toBe(true);
    expect(canTransitionTaskStatus("running", "verifying")).toBe(true);
    expect(canTransitionTaskStatus("verifying", "completed")).toBe(true);
  });

  it("increments the version and records the transition reason", () => {
    expect(transitionTask(task("running"), "retrying", {
      now: "2026-10-15T00:01:00.000Z",
      reason: "provider timeout",
    })).toEqual({
      taskId: "task-1",
      status: "retrying",
      version: 4,
      updatedAt: "2026-10-15T00:01:00.000Z",
      reason: "provider timeout",
    });
  });

  it("rejects invalid and terminal transitions", () => {
    expect(() => transitionTask(task("queued"), "completed")).toThrow(InvalidTaskTransitionError);
    expect(() => transitionTask(task("completed"), "running")).toThrow("completed -> running");
    expect(taskStatusTransitions("failed")).toEqual([]);
    expect(isTerminalTaskStatus("completed")).toBe(true);
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("cancelled")).toBe(true);
    expect(isTerminalTaskStatus("running")).toBe(false);
  });
});
