import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersistentJobQueue } from "./persistent-job-queue.js";
import { PersistentJobRunner } from "./persistent-job-runner.js";

describe("PersistentJobRunner", () => {
  it("executes queued jobs and persists the result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-runner-"));
    const queue = new PersistentJobQueue(path.join(dir, "jobs.json"));
    const runner = new PersistentJobRunner(queue, { pollIntervalMs: 10 });
    runner.register("agent.message", async (job) => ({
      message: job.payload.message,
      receipt: "completed",
    }));

    const job = queue.enqueue("agent.message", { message: "hello" });
    runner.start();
    await waitFor(() => queue.list()[0]?.status === "completed");
    await runner.stop();

    const completed = queue.list()[0];
    expect(completed?.id).toBe(job.id);
    expect(completed?.result).toEqual({
      message: "hello",
      receipt: "completed",
    });
    expect(runner.getStatus().running).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("requeues an interrupted running job when a new queue instance loads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-recovery-"));
    const file = path.join(dir, "jobs.json");
    const first = new PersistentJobQueue(file);
    const job = first.enqueue("agent.message", { message: "recover" });
    expect(first.dequeue()?.id).toBe(job.id);

    const recovered = new PersistentJobQueue(file);
    expect(recovered.list()[0]?.status).toBe("queued");
    expect(recovered.dequeue()?.id).toBe(job.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
