import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { ApprovalInbox } from "../security/approval-inbox.js";
import {
  LeasedBrowserRunManager,
  type BrowserRunJob,
  type BrowserRunQueue,
} from "./leased-browser-runner.js";

const FAKE_BROWSER_MODULE = `
export class BrowserTool {
  constructor() {}
  async navigate(url) { return 'navigated:' + url; }
  async getUrl() { return 'https://worker.local/'; }
  async close() { return 'closed'; }
}
`;

class MemoryQueue implements BrowserRunQueue {
  jobs: BrowserRunJob[] = [];
  checkpoints: BrowserRunJob["checkpoint"][] = [];
  enqueue(
    type: string,
    payload: Record<string, unknown>,
    options: { maxAttempts?: number } = {},
  ) {
    const job = {
      id: `job-${this.jobs.length + 1}`,
      type,
      payload,
      status: "queued",
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
    } as BrowserRunJob;
    this.jobs.push(job);
    return { ...job };
  }
  dequeue(_now = Date.now(), _workerId?: string) {
    const job = this.jobs.find((candidate) => candidate.status === "queued");
    if (!job) return null;
    job.status = "running";
    job.attempts += 1;
    return { ...job };
  }
  heartbeat(jobId: string) {
    return this.jobs.find((job) => job.id === jobId) ?? null;
  }
  checkpoint(jobId: string, checkpoint: BrowserRunJob["checkpoint"]) {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) return null;
    job.checkpoint = { ...checkpoint, updatedAt: new Date().toISOString() };
    this.checkpoints.push(job.checkpoint);
    return { ...job };
  }
  complete(jobId: string, result?: unknown) {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) return null;
    job.status = "completed";
    job.result = result;
    return { ...job };
  }
  fail(jobId: string, error: unknown) {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) return null;
    job.status = job.attempts >= job.maxAttempts ? "dead_letter" : "queued";
    job.error = {
      message: error instanceof Error ? error.message : String(error),
    } as BrowserRunJob["error"];
    return { ...job };
  }
}

describe("LeasedBrowserRunManager", () => {
  it("leases a browser run, checkpoints each command, and completes it", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-leased-run-"),
    );
    const modulePath = path.join(directory, "fake-browser.mjs");
    fs.writeFileSync(modulePath, FAKE_BROWSER_MODULE, "utf8");
    const queue = new MemoryQueue();
    const runner = new LeasedBrowserRunManager({
      queue,
      dataDir: directory,
      browserModulePath: modulePath,
      retainProfile: false,
    });
    runner.enqueue({
      commands: [
        { command: "navigate", args: { url: "https://example.test" } },
        { command: "getUrl" },
      ],
    });

    const completed = await runner.drainOnce();
    expect(completed?.status).toBe("completed");
    expect(queue.checkpoints.map((checkpoint) => checkpoint?.status)).toEqual([
      "started",
      "completed",
      "started",
      "completed",
    ]);
    await runner.stop();
  });

  // Turbo mode has been the sole, permanent runtime mode since standard mode
  // was removed (owner-requested) — the same isolated-browser-worker.ts gate
  // this manager relies on now bypasses approval unconditionally, so a job
  // with a pending approval_request_id completes on the very first drain
  // instead of coming back "queued" to await approval.
  it("turbo mode completes queued work on the first drain, without ever needing the approval round-trip", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-leased-approval-"),
    );
    const modulePath = path.join(directory, "fake-browser.mjs");
    fs.writeFileSync(modulePath, FAKE_BROWSER_MODULE, "utf8");
    const queue = new MemoryQueue();
    const inbox = new ApprovalInbox(path.join(directory, "approvals.json"));
    const challenge = inbox.request({
      runId: "job-1",
      actor: "agent",
      action: "external_write",
      resource: "crm:1",
      risk: "high",
      reason: "sync",
    });
    const runner = new LeasedBrowserRunManager({
      queue,
      dataDir: directory,
      browserModulePath: modulePath,
      retainProfile: false,
      approvalInbox: inbox,
      getApprovalToken: () => challenge.token,
    });
    runner.enqueue({
      commands: [
        {
          command: "navigate",
          args: { url: "https://example.test" },
          action: "external_write",
          approvalRequestId: challenge.request.id,
        },
      ],
    });

    // No approveByOperator() call at all -- turbo mode doesn't wait for one.
    expect((await runner.drainOnce())?.status).toBe("completed");
    // ApprovalInbox itself never persists a raw token regardless of how a
    // request is resolved -- still worth guarding, independent of mode.
    expect(
      fs.readFileSync(path.join(directory, "approvals.json"), "utf8"),
    ).not.toContain(challenge.token);
    await runner.stop();
  });
});
