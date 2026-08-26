import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PersistentJobQueue } from "./persistent-job-queue.js";

describe("persistent job queue", () => {
  it("persists queued jobs and recovers stale running jobs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-jobs-"));
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-jobs-"));
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
      recovery: { retryCount: 1 },
    });
    expect(retried?.recovery.lastFailure?.message).toContain(
      "provider timeout",
    );
    expect(retried?.recovery.deadLetteredAt).toEqual(expect.any(String));
    expect(
      new PersistentJobQueue(path.join(tempDir, "queue.json")).get(job.id),
    ).toMatchObject({
      recovery: { retryCount: 1 },
    });
    expect(queue.list({ status: "queued" }).map((item) => item.id)).toContain(
      job.id,
    );
  });

  it("normalizes retry options and ignores malformed persisted jobs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-jobs-"));
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-jobs-"));
    const queue = new PersistentJobQueue(path.join(tempDir, "queue.json"));
    const job = queue.enqueue("channel.send", { body: "retry me" });

    expect(queue.cancel(job.id)).toBe(true);
    expect(queue.retry(job.id, 25)?.status).toBe("queued");
    expect(queue.dequeue(Date.now() + 25)?.id).toBe(job.id);
    expect(queue.get(job.id)?.recovery.retryCount).toBe(1);
  });

  it("deduplicates active jobs by idempotency key", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-jobs-"));
    const queue = new PersistentJobQueue(path.join(tempDir, "queue.json"));
    const first = queue.enqueue(
      "channel.send",
      { body: "once" },
      { idempotencyKey: "event-123" },
    );
    const duplicate = queue.enqueue(
      "channel.send",
      { body: "duplicate" },
      { idempotencyKey: "event-123" },
    );

    expect(duplicate.id).toBe(first.id);
    expect(queue.list()).toHaveLength(1);
  });

  it("requires the current worker lease to complete and persists checkpoints", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-jobs-"));
    const queue = new PersistentJobQueue(path.join(tempDir, "queue.json"));
    const job = queue.enqueue("agent.run", {});
    const claimed = queue.dequeue(Date.now(), "worker-a", 1_000);

    expect(claimed?.id).toBe(job.id);
    expect(
      queue.checkpoint(
        job.id,
        {
          id: "cp-1",
          step: "plan",
          status: "completed",
          data: { planVersion: 1 },
        },
        "worker-a",
      )?.checkpoint?.id,
    ).toBe("cp-1");
    expect(queue.complete(job.id, { ok: true }, "worker-b")).toBeNull();
    expect(queue.complete(job.id, { ok: true }, "worker-a")?.status).toBe(
      "completed",
    );
  });

  it("preserves checkpoints and idempotency across a worker restart", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-jobs-restart-"),
    );
    const filePath = path.join(tempDir, "queue.json");
    const first = new PersistentJobQueue(filePath);
    const job = first.enqueue(
      "agent.run",
      { artifact: "workspace/result.md" },
      { idempotencyKey: "artifact-run-1" },
    );
    const claimed = first.dequeue(Date.now(), "worker-a", 60_000);
    expect(claimed?.id).toBe(job.id);
    expect(
      first.checkpoint(
        job.id,
        {
          id: "checkpoint-1",
          step: "artifact-written",
          status: "completed",
          data: { verified: false },
        },
        "worker-a",
      )?.checkpoint?.id,
    ).toBe("checkpoint-1");

    const restarted = new PersistentJobQueue(filePath);
    const duplicate = restarted.enqueue(
      "agent.run",
      { artifact: "workspace/result.md" },
      { idempotencyKey: "artifact-run-1" },
    );
    expect(duplicate.id).toBe(job.id);
    expect(restarted.list()).toHaveLength(1);
    expect(restarted.list()[0]?.checkpoint).toMatchObject({
      id: "checkpoint-1",
      step: "artifact-written",
    });
    expect(restarted.dequeue(Date.now(), "worker-b", 60_000)).toBeNull();
    expect(
      restarted.complete(job.id, { verified: true }, "worker-a")?.status,
    ).toBe("completed");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reclaims an expired worker lease", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-jobs-"));
    const queue = new PersistentJobQueue(path.join(tempDir, "queue.json"));
    const job = queue.enqueue("agent.run", {});
    expect(queue.dequeue(Date.now(), "worker-a", 1)?.id).toBe(job.id);
    const recovered = queue.dequeue(Date.now() + 10, "worker-b", 1);

    expect(recovered?.id).toBe(job.id);
    expect(recovered?.leaseOwner).toBe("worker-b");
    expect(recovered?.attempts).toBe(2);
  });
});
