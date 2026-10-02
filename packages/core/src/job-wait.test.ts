import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersistentJobQueue } from "./persistent-job-queue.js";
import { waitForJob } from "./job-wait.js";

describe("waitForJob", () => {
  it("resolves when job completes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-wait-"));
    const q = new PersistentJobQueue(path.join(dir, "jobs.json"));
    const job = q.enqueue("agent.message", { message: "hi" });
    // Complete in background
    setTimeout(() => {
      q.dequeue(Date.now(), "w1", 30_000);
      q.complete(job.id, { ok: true }, "w1");
    }, 30);
    const done = await waitForJob(q, job.id, { timeoutMs: 2000, pollMs: 10 });
    expect(done?.status).toBe("completed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("cancels on abort", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-wait-"));
    const q = new PersistentJobQueue(path.join(dir, "jobs.json"));
    const job = q.enqueue("agent.message", { message: "hi" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await waitForJob(q, job.id, { signal: ac.signal, timeoutMs: 2000, pollMs: 10 });
    const got = q.get(job.id);
    expect(got?.status).toBe("cancelled");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
