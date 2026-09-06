import * as crypto from "node:crypto";
import {
  IsolatedBrowserWorker,
  type IsolatedBrowserWorkerInput,
  type IsolatedBrowserWorkerOptions,
} from "./isolated-browser-worker.js";
import type { ApprovalInbox } from "../security/approval-inbox.js";

export interface BrowserRunJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  maxAttempts: number;
  checkpoint?: {
    id: string;
    step: string;
    status: string;
    updatedAt: string;
    data?: Record<string, unknown>;
  };
}

export interface BrowserRunQueue {
  enqueue(
    type: string,
    payload: Record<string, unknown>,
    options?: { maxAttempts?: number; idempotencyKey?: string },
  ): BrowserRunJob;
  dequeue(
    now?: number,
    workerId?: string,
    leaseDurationMs?: number,
  ): BrowserRunJob | null;
  heartbeat(
    jobId: string,
    workerId: string,
    leaseDurationMs?: number,
  ): BrowserRunJob | null;
  checkpoint(
    jobId: string,
    checkpoint: {
      id: string;
      step: string;
      status: "started" | "completed" | "failed";
      data?: Record<string, unknown>;
    },
    workerId?: string,
  ): BrowserRunJob | null;
  complete(
    jobId: string,
    result?: unknown,
    workerId?: string,
  ): BrowserRunJob | null;
  fail(
    jobId: string,
    error: unknown,
    retryDelayMs?: number,
    workerId?: string,
  ): BrowserRunJob | null;
}

export interface BrowserRunPayload {
  commands: IsolatedBrowserWorkerInput[];
}

export interface LeasedBrowserRunnerOptions {
  queue: BrowserRunQueue;
  dataDir: string;
  workerId?: string;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  browserModulePath?: string;
  retainProfile?: boolean;
  approvalInbox?: ApprovalInbox;
  getApprovalToken?: (
    requestId: string,
  ) => Promise<string | undefined> | string | undefined;
  workerOptions?: Omit<
    IsolatedBrowserWorkerOptions,
    | "dataDir"
    | "runId"
    | "workerId"
    | "approvalInbox"
    | "browserModulePath"
    | "retainProfile"
  >;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_MS = 500;

export class ApprovalPendingError extends Error {
  readonly code = "approval_pending";
  constructor(requestId: string) {
    super(`Approval is pending for request ${requestId}`);
    this.name = "ApprovalPendingError";
  }
}

export class LeasedBrowserRunManager {
  private readonly queue: BrowserRunQueue;
  private readonly dataDir: string;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly browserModulePath?: string;
  private readonly retainProfile: boolean;
  private readonly approvalInbox?: ApprovalInbox;
  private readonly getApprovalToken?: LeasedBrowserRunnerOptions["getApprovalToken"];
  private readonly workerOptions: LeasedBrowserRunnerOptions["workerOptions"];
  private activeWorker: IsolatedBrowserWorker | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private stopped = false;

  constructor(options: LeasedBrowserRunnerOptions) {
    this.queue = options.queue;
    this.dataDir = options.dataDir;
    this.workerId =
      options.workerId ?? `miki-browser-runner-${crypto.randomUUID()}`;
    this.leaseDurationMs = positiveInt(
      options.leaseDurationMs,
      DEFAULT_LEASE_MS,
    );
    this.pollIntervalMs = positiveInt(options.pollIntervalMs, DEFAULT_POLL_MS);
    this.browserModulePath = options.browserModulePath;
    this.retainProfile = options.retainProfile ?? true;
    this.approvalInbox = options.approvalInbox;
    this.getApprovalToken = options.getApprovalToken;
    this.workerOptions = options.workerOptions;
  }

  enqueue(
    payload: BrowserRunPayload,
    options: { maxAttempts?: number; idempotencyKey?: string } = {},
  ): BrowserRunJob {
    const commands = payload.commands.map((command) => ({
      command: command.command,
      args: command.args,
      action: command.action,
      approvalRequestId: command.approvalRequestId,
      // Never persist raw approval tokens in the durable queue.
    }));
    return this.queue.enqueue("browser.run", { commands }, options);
  }

  async drainOnce(now = Date.now()): Promise<BrowserRunJob | null> {
    if (this.stopped || this.draining) return null;
    this.draining = true;
    const job = this.queue.dequeue(now, this.workerId, this.leaseDurationMs);
    if (!job) {
      this.draining = false;
      return null;
    }
    let heartbeat: NodeJS.Timeout | null = null;
    let leaseLost = false;
    try {
      const commands = readCommands(job.payload.commands);
      heartbeat = setInterval(
        () => {
          if (
            !this.queue.heartbeat(job.id, this.workerId, this.leaseDurationMs)
          ) {
            leaseLost = true;
            this.activeWorker?.kill("Browser run lease lost");
          }
        },
        Math.max(250, Math.floor(this.leaseDurationMs / 3)),
      );
      heartbeat.unref();
      this.activeWorker = new IsolatedBrowserWorker({
        dataDir: this.dataDir,
        runId: job.id,
        workerId: this.workerId,
        browserModulePath: this.browserModulePath,
        retainProfile: this.retainProfile,
        approvalInbox: this.approvalInbox,
        ...this.workerOptions,
      });
      const results: unknown[] = [];
      for (let index = 0; index < commands.length; index += 1) {
        if (leaseLost) throw new Error("Browser run lease lost");
        const command = await this.withApprovalToken(commands[index]);
        this.queue.checkpoint(
          job.id,
          { id: `command-${index}`, step: command.command, status: "started" },
          this.workerId,
        );
        const result = await this.activeWorker.execute(command);
        results.push(result);
        this.queue.checkpoint(
          job.id,
          {
            id: `command-${index}`,
            step: command.command,
            status: "completed",
            data: { index },
          },
          this.workerId,
        );
      }
      const completed = this.queue.complete(
        job.id,
        { results, workerId: this.workerId },
        this.workerId,
      );
      return completed;
    } catch (error) {
      return this.queue.fail(
        job.id,
        error,
        error instanceof ApprovalPendingError ? this.leaseDurationMs : 1_000,
        this.workerId,
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await this.activeWorker?.close();
      this.activeWorker = null;
      this.draining = false;
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.drainOnce();
    }, this.pollIntervalMs);
    void this.drainOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activeWorker?.close();
    this.activeWorker = null;
  }

  private async withApprovalToken(
    command: IsolatedBrowserWorkerInput,
  ): Promise<IsolatedBrowserWorkerInput> {
    if (!command.approvalRequestId) return command;
    const token = await this.getApprovalToken?.(command.approvalRequestId);
    if (!token) throw new ApprovalPendingError(command.approvalRequestId);
    return { ...command, approvalToken: token };
  }
}

function readCommands(value: unknown): IsolatedBrowserWorkerInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100)
    throw new Error("browser.run requires 1-100 commands");
  return value.map((item) => {
    if (!item || typeof item !== "object")
      throw new Error("Invalid browser command");
    const command = item as Record<string, unknown>;
    if (typeof command.command !== "string")
      throw new Error("Browser command name is required");
    return {
      command: command.command as IsolatedBrowserWorkerInput["command"],
      args:
        command.args && typeof command.args === "object"
          ? (command.args as Record<string, unknown>)
          : undefined,
      action:
        typeof command.action === "string"
          ? (command.action as IsolatedBrowserWorkerInput["action"])
          : undefined,
      approvalRequestId:
        typeof command.approvalRequestId === "string"
          ? command.approvalRequestId
          : undefined,
    };
  });
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
