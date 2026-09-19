import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { TaskQueue } from "./task-queue.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("SQLite durable task queue", () => {
  it("persists the complete task envelope and blocks duplicate delivery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-sqlite-")); dirs.push(dir);
    const databasePath = path.join(dir, "tasks.db");
    const first = new TaskQueue({ maxSize: 10, databasePath });
    const task = first.enqueue("canonical-session", "full atomic message", {
      senderIdentity: "user-42", channel: "telegram", idempotencyKey: "telegram:msg-9", artifactRefs: ["artifact://a"],
    })!;
    const duplicate = first.enqueue("other-session", "must not execute", { idempotencyKey: "telegram:msg-9" });
    expect(duplicate?.id).toBe(task.id);
    expect(duplicate?.message).toBe("full atomic message");
    first.markRunning(task.id);
    const restarted = new TaskQueue({ maxSize: 10, databasePath });
    const recovered = restarted.getTask(task.id)!;
    expect(recovered).toMatchObject({ sessionId: "canonical-session", senderIdentity: "user-42", channel: "telegram", message: "full atomic message", idempotencyKey: "telegram:msg-9", artifactRefs: ["artifact://a"], status: "pending", retryCount: 0 });
    restarted.complete(task.id, undefined, "done", ["artifact://result"]);
    const final = new TaskQueue({ maxSize: 10, databasePath }).getTask(task.id)!;
    expect(final).toMatchObject({ status: "completed", resultSummary: "done", artifactRefs: ["artifact://result"] });
  });
});
