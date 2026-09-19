import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { TaskQueue } from "./task-queue.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("TaskQueue persistence", () => {
  it("replays pending and running work as pending after restart", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-task-queue-"),
    );
    tempDirs.push(directory);
    const persistencePath = path.join(directory, "task-queue.json");
    const first = new TaskQueue({ maxSize: 10, persistencePath });
    const pending = first.enqueue("session-1", "pending work")!;
    const running = first.enqueue("session-1", "running work")!;
    first.markRunning(running.id);

    const reopened = new TaskQueue({ maxSize: 10, persistencePath });
    expect(reopened.getTask(pending.id)?.status).toBe("pending");
    expect(reopened.getTask(running.id)?.status).toBe("pending");
    expect(reopened.getStats()).toMatchObject({ pending: 2, running: 0 });
  });

  it("retains terminal task records and ignores a corrupt snapshot safely", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-task-queue-"),
    );
    tempDirs.push(directory);
    const persistencePath = path.join(directory, "task-queue.json");
    const queue = new TaskQueue({ maxSize: 10, persistencePath });
    const task = queue.enqueue("session-1", "terminal work")!;
    queue.dequeue();
    queue.complete(task.id, "checkpoint-1");

    const reopened = new TaskQueue({ maxSize: 10, persistencePath });
    expect(reopened.getTask(task.id)?.status).toBe("completed");
    expect(reopened.getStats()).toMatchObject({ completed: 1, total: 1 });

    fs.writeFileSync(persistencePath, "not-json", "utf8");
    const afterCorruption = new TaskQueue({ maxSize: 10, persistencePath });
    expect(afterCorruption.getStats()).toEqual({
      pending: 0,
      running: 0,
      completed: 0,
      total: 0,
    });
  });
});
