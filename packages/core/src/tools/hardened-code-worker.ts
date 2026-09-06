import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export type CodeNetworkMode = "deny" | "allow";

export interface HardenedCodeWorkerOptions {
  workspaceDir: string;
  allowedCommands?: string[];
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  networkMode?: CodeNetworkMode;
}

export interface CodeRunOptions {
  cwd?: string;
  timeoutMs?: number;
  networkMode?: CodeNetworkMode;
  env?: Record<string, string>;
}

export interface CodeRunResult {
  ok: boolean;
  status: "completed" | "blocked" | "timed_out" | "failed";
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  redactions: number;
  reason?: string;
}

const DEFAULT_ALLOWED_COMMANDS = [
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "python",
  "python3",
  "pytest",
  "git",
  "go",
  "cargo",
  "ruby",
];

const BLOCKED_COMMANDS = new Set([
  "sudo",
  "su",
  "rm",
  "rmdir",
  "del",
  "format",
  "mkfs",
  "mount",
  "umount",
  "chmod",
  "chown",
  "curl",
  "wget",
  "ssh",
  "scp",
  "nc",
  "netcat",
  "docker",
  "podman",
  "kubectl",
]);

const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:sk|pk|ghp|github_pat|xox[baprs]-)[A-Za-z0-9_\-]{8,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
];

function commandName(command: string): string {
  return path
    .basename(command)
    .toLowerCase()
    .replace(/\.exe$/, "");
}

function redact(value: string): { value: string; count: number } {
  let output = value;
  let count = 0;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, () => {
      count += 1;
      return "[REDACTED]";
    });
  }
  return { value: output, count };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function resolveWorkspacePath(
  root: string,
  candidate: string,
): Promise<string> {
  const resolved = path.resolve(root, candidate);
  if (!isInside(root, resolved)) {
    throw new Error("Path escapes the configured Miki workspace.");
  }
  try {
    const realRoot = await fs.realpath(root);
    const realCandidate = await fs.realpath(resolved);
    if (!isInside(realRoot, realCandidate)) {
      throw new Error(
        "Path escapes the configured Miki workspace through a symlink.",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolved;
}

export class HardenedCodeWorker {
  private readonly root: string;
  private readonly allowedCommands: Set<string>;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly networkMode: CodeNetworkMode;

  constructor(options: HardenedCodeWorkerOptions) {
    this.root = path.resolve(options.workspaceDir);
    this.allowedCommands = new Set(
      (options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS).map((item) =>
        commandName(item),
      ),
    );
    this.defaultTimeoutMs = Math.min(
      Math.max(options.defaultTimeoutMs ?? 120_000, 1000),
      900_000,
    );
    this.maxOutputBytes = Math.min(
      Math.max(options.maxOutputBytes ?? 256_000, 4096),
      2_000_000,
    );
    this.networkMode = options.networkMode ?? "deny";
  }

  async run(
    command: string,
    args: string[] = [],
    options: CodeRunOptions = {},
  ): Promise<CodeRunResult> {
    const normalizedCommand = commandName(command);
    const cwd = await resolveWorkspacePath(this.root, options.cwd ?? ".");
    const networkMode = options.networkMode ?? this.networkMode;
    const baseResult = {
      command,
      args,
      cwd,
      exitCode: null as number | null,
      stdout: "",
      stderr: "",
      redactions: 0,
    };

    if (BLOCKED_COMMANDS.has(normalizedCommand)) {
      return {
        ...baseResult,
        ok: false,
        status: "blocked",
        reason: `Command '${normalizedCommand}' is blocked by Miki safety policy.`,
      };
    }
    if (!this.allowedCommands.has(normalizedCommand)) {
      return {
        ...baseResult,
        ok: false,
        status: "blocked",
        reason: `Command '${normalizedCommand}' is not in the configured allowlist.`,
      };
    }

    const timeoutMs = Math.min(
      Math.max(options.timeoutMs ?? this.defaultTimeoutMs, 1000),
      900_000,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      MIKI_NETWORK_ACCESS: networkMode,
      ...(networkMode === "deny"
        ? { HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" }
        : {}),
    };

    return await new Promise<CodeRunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
      });
      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (target === "stdout")
          stdout = `${stdout}${text}`.slice(-this.maxOutputBytes);
        else stderr = `${stderr}${text}`.slice(-this.maxOutputBytes);
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        const out = redact(stdout);
        const err = redact(`${stderr}${error.message}`);
        resolve({
          ...baseResult,
          ok: false,
          status: "failed",
          stdout: out.value,
          stderr: err.value,
          redactions: out.count + err.count,
        });
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        const out = redact(stdout);
        const err = redact(stderr);
        resolve({
          ...baseResult,
          ok: !timedOut && exitCode === 0,
          status: timedOut
            ? "timed_out"
            : exitCode === 0
              ? "completed"
              : "failed",
          exitCode,
          stdout: out.value,
          stderr: err.value,
          redactions: out.count + err.count,
          ...(timedOut ? { reason: `Execution exceeded ${timeoutMs}ms.` } : {}),
        });
      });
    });
  }
}

export function createHardenedCodeWorker(
  options: HardenedCodeWorkerOptions,
): HardenedCodeWorker {
  return new HardenedCodeWorker(options);
}
