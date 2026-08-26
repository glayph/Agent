import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApprovalInbox,
  requiresHumanApproval,
  type ApprovalAction,
} from "../security/approval-inbox.js";

export type IsolatedBrowserCommand =
  | "navigate"
  | "click"
  | "type"
  | "invoke"
  | "fill"
  | "press"
  | "extract"
  | "screenshot"
  | "getHtml"
  | "getUrl"
  | "scrollDown"
  | "scrollToBottom"
  | "close";

export interface IsolatedBrowserWorkerInput {
  command: IsolatedBrowserCommand;
  args?: Record<string, unknown>;
  action?: ApprovalAction;
  approvalRequestId?: string;
  approvalToken?: string;
  timeoutMs?: number;
}

export interface IsolatedBrowserWorkerOptions {
  dataDir: string;
  runId?: string;
  workerId?: string;
  maxRuntimeMs?: number;
  browserModulePath?: string;
  retainProfile?: boolean;
  approvalInbox?: ApprovalInbox;
  env?: Record<string, string>;
}

interface WorkerResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const MAX_COMMAND_TIMEOUT_MS = 120_000;
const WORKER_SCRIPT = String.raw`
const modulePath = process.env.MIKI_BROWSER_MODULE;
const dataDir = process.env.MIKI_BROWSER_DATA_DIR;
if (!modulePath || !dataDir) throw new Error("Browser worker environment is incomplete");
const { BrowserTool } = await import(modulePath);
const tool = new BrowserTool(true, dataDir, undefined, { clearStateEveryN: 5 });
const readline = (await import("node:readline")).createInterface({ input: process.stdin, crlfDelay: Infinity });
const safeString = (value) => typeof value === "string" ? value : "";
const execute = async (command, args = {}) => {
  switch (command) {
    case "navigate": return tool.navigate(safeString(args.url), Number(args.retries ?? 0));
    case "click": return tool.click(safeString(args.selector));
    case "type": return tool.type(safeString(args.text), safeString(args.selector));
    case "invoke": return tool.invoke(args.target || {});
    case "fill": return tool.fill(safeString(args.selector), safeString(args.value));
    case "press": return tool.press(safeString(args.key), args.selector ? safeString(args.selector) : undefined);
    case "extract": return tool.extract(args.selector ? safeString(args.selector) : undefined);
    case "screenshot": return tool.screenshot();
    case "getHtml": return tool.getHtml();
    case "getUrl": return tool.getUrl();
    case "scrollDown": return tool.scrollDown(args.pixels == null ? undefined : Number(args.pixels));
    case "scrollToBottom": return tool.scrollToBottom();
    case "close": return tool.close();
    default: throw new Error("Unsupported browser command");
  }
};
for await (const line of readline) {
  if (!line.trim()) continue;
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  try {
    const result = await execute(message.command, message.args || {});
    process.stdout.write(JSON.stringify({ requestId: message.requestId, ok: true, result }) + "\n");
    if (message.command === "close") process.exit(0);
  } catch (error) {
    process.stdout.write(JSON.stringify({ requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
  }
}
`;

export class IsolatedBrowserWorker {
  private readonly runId: string;
  private readonly workerId: string;
  private readonly dataDir: string;
  private readonly profileDir: string;
  private readonly maxRuntimeMs: number;
  private readonly browserModulePath: string;
  private readonly retainProfile: boolean;
  private readonly approvalInbox?: ApprovalInbox;
  private readonly env: Record<string, string>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private pending = new Map<string, PendingRequest>();
  private startPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: IsolatedBrowserWorkerOptions) {
    this.runId = normalizeId(options.runId ?? crypto.randomUUID());
    this.workerId = normalizeId(options.workerId ?? `browser-${this.runId}`);
    this.dataDir = path.resolve(options.dataDir);
    this.profileDir = path.join(this.dataDir, "browser-runs", this.runId);
    this.maxRuntimeMs = boundedTimeout(options.maxRuntimeMs, 5 * 60_000);
    this.browserModulePath =
      options.browserModulePath ??
      fileURLToPath(new URL("./browser.js", import.meta.url));
    this.retainProfile = options.retainProfile ?? true;
    this.approvalInbox = options.approvalInbox;
    this.env = options.env ?? {};
  }

  get id(): string {
    return this.workerId;
  }
  get profilePath(): string {
    return this.profileDir;
  }
  get pid(): number | undefined {
    return this.child?.pid;
  }

  async execute(input: IsolatedBrowserWorkerInput): Promise<unknown> {
    if (this.closed) throw new Error("Browser worker is closed");
    const action = input.action;
    if (action && requiresHumanApproval(action)) {
      if (
        !this.approvalInbox ||
        !input.approvalRequestId ||
        !input.approvalToken
      ) {
        throw new Error(
          "Human approval is required before this browser side effect",
        );
      }
      this.approvalInbox.assertApproved(
        input.approvalRequestId,
        input.approvalToken,
      );
    }
    await this.start();
    const requestId = crypto.randomUUID();
    const timeoutMs = boundedTimeout(input.timeoutMs, this.maxRuntimeMs);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        this.terminate(
          new Error(`Browser command timed out after ${timeoutMs}ms`),
        );
        reject(new Error(`Browser command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        this.child?.stdin.write(
          `${JSON.stringify({ requestId, command: input.command, args: input.args ?? {} })}\n`,
        );
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startImpl();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.stdin.write(
          `${JSON.stringify({ requestId: crypto.randomUUID(), command: "close", args: {} })}\n`,
        );
      } catch {
        /* process may already be gone */
      }
      setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
      }, 500).unref();
    }
    this.rejectPending(new Error("Browser worker closed"));
    if (!this.retainProfile)
      fs.rmSync(this.profileDir, { recursive: true, force: true });
  }

  kill(reason = "Browser worker terminated"): void {
    this.terminate(new Error(reason));
  }

  private async startImpl(): Promise<void> {
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.profileDir, 0o700);
    } catch {
      /* best effort */
    }
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", WORKER_SCRIPT],
      {
        cwd: this.profileDir,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: process.env.NODE_ENV ?? "production",
          MIKI_BROWSER_MODULE: this.browserModulePath,
          MIKI_BROWSER_DATA_DIR: this.profileDir,
          MIKI_BROWSER_WORKER_ID: this.workerId,
          MIKI_BROWSER_RUN_ID: this.runId,
          ...this.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      /* never expose browser stderr as a result */
    });
    child.on("error", (error) => this.terminate(error));
    child.on("exit", (code, signal) => {
      this.child = null;
      if (!this.closed && (code !== 0 || signal))
        this.rejectPending(
          new Error(
            `Browser worker exited (${code ?? "null"}/${signal ?? "none"})`,
          ),
        );
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 10);
      child.once("error", reject);
      timer.unref();
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.resolveMessage(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private resolveMessage(line: string): void {
    let message: WorkerResponse;
    try {
      message = JSON.parse(line) as WorkerResponse;
    } catch {
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.ok) pending.resolve(message.result);
    else
      pending.reject(
        new Error(message.error || "Browser worker command failed"),
      );
  }

  private terminate(error: Error): void {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGKILL");
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}

function normalizeId(value: string): string {
  const id = value.trim();
  if (!id || !/^[A-Za-z0-9._:-]+$/.test(id))
    throw new Error("Invalid worker/run id");
  return id.slice(0, 128);
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value == null) return fallback;
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("timeoutMs must be a positive finite number");
  return Math.min(Math.floor(value), MAX_COMMAND_TIMEOUT_MS);
}
