import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PersistentJobQueue } from "./persistent-job-queue.js";

describe("persistent job queue", () => {
  it("persists queued jobs and recovers stale running jobs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-jobs-"));
    const filePath = path.join(tempDir, "queue.json");
    const queue = new PersistentJobQueue(filePath);

    const low = queue.enqueue("channel.send", { body: "low" });
    const high = queue.enqueue("agent.run", { body: "high" }, { priority: 10 });
    expect(queue.dequeue()?.id).toBe(high.id);

    const recovered = new PersistentJobQueue(filePath);
    expect(recovered.list().find((job) => job.id === high.id)?.status).toBe(
      "queued",
    );
    expect(recovered.cancel(low.id)).toBe(true);
  });

  it("dead-letters jobs after max attempts", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-jobs-"));
    const queue = new PersistentJobQueue(path.join(tempDir, "queue.json"));
    const job = queue.enqueue("agent.run", {}, { maxAttempts: 1 });
    const running = queue.dequeue();
    expect(running?.id).toBe(job.id);

    const failed = queue.fail(job.id, new Error("provider timeout"), 0);
    expect(failed?.status).toBe("dead_letter");
    expect(queue.deadLetters()).toHaveLength(1);

    const retried = queue.retry(job.id);
    expect(retried).toMatchObject({
      id: job.id,
      status: "queued",
      attempts: 0,
      progress: 0,
      error: undefined,
    });
    expect(queue.list({ status: "queued" }).map((item) => item.id)).toContain(
      job.id,
    );
  });

  it("normalizes retry options and ignores malformed persisted jobs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-jobs-"));
    const filePath = path.join(tempDir, "queue.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "valid-running",
            type: "agent.run",
            payload: {},
            priority: 1,
            status: "running",
            attempts: 0,
            maxAttempts: 2,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            runAfter: Date.now(),
            progress: 0,
          },
          { id: "broken", status: "queued" },
        ],
      }),
      "utf-8",
    );

    const recovered = new PersistentJobQueue(filePath);
    expect(recovered.list()).toHaveLength(1);
    expect(recovered.list()[0]).toMatchObject({
      id: "valid-running",
      status: "queued",
    });

    const job = recovered.enqueue(
      "agent.run",
      {},
      {
        maxAttempts: 0,
        delayMs: -100,
      },
    );
    expect(job.maxAttempts).toBe(1);
    expect(job.runAfter).toBeLessThanOrEqual(Date.now() + 50);
  });

  it("cancels and explicitly retries queued work", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-jobs-"));
    const queue = new PersistentJobQueue(path.join(tempDir, "queue.json"));
    const job = queue.enqueue("channel.send", { body: "retry me" });

    expect(queue.cancel(job.id)).toBe(true);
    expect(queue.retry(job.id, 25)?.status).toBe("queued");
    expect(queue.dequeue(Date.now() + 25)?.id).toBe(job.id);
  });
});
