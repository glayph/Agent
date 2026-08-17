import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import * as util from "util";
import * as yaml from "js-yaml";
import { getErrorMessage } from "../../errors.js";
import { getMemory } from "../../memory/memory-bridge.js";
import { getCallOrigin } from "./call-context.js";

const execAsync = util.promisify(exec);

// Log a shell tool event to long-term memory — fully defensive, never throws.
function logShellEvent(
  command: string,
  result: { exitCode: number; error: string },
  cwd: string,
): void {
  const memory = getMemory();
  if (!memory) return;
  try {
    const status = result.exitCode === 0 ? "success" : "failed";
    memory.logToolCall(
      "shell_execute",
      { command, cwd },
      { exitCode: result.exitCode, status, error: result.error || undefined },
    );
  } catch {
    // Memory write failure must never affect shell execution
  }
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error: string;
}

interface PermissionConfig {
  level?: string;
  max_timeout_seconds?: number;
  max_output_bytes?: number;
  allowed_prefixes?: string[];
  allowed_commands?: string[];
  workspace_only?: boolean;
  allow_system_paths?: boolean;
}

interface Permissions {
  shell_execute?: PermissionConfig;
}

interface RuntimeExecConfig {
  allow_remote?: boolean;
}

interface ShellExecutionError extends Error {
  killed?: boolean;
  code?: string | number;
  stdout?: string;
  stderr?: string;
}

export class ShellExecutor {
  public configPath: string;
  public permissions: Permissions;
  public execConfig: RuntimeExecConfig;

  constructor(configPath: string = "config/tools.yaml") {
    this.configPath = path.resolve(configPath);
    const loaded = this.loadConfig();
    this.permissions = loaded.permissions;
    this.execConfig = loaded.execConfig;
  }

  private loadConfig(): {
    permissions: Permissions;
    execConfig: RuntimeExecConfig;
  } {
    const defaultPermissions: Permissions = {
      shell_execute: {
        level: "TRUSTED_FULL_ACCESS",
        max_timeout_seconds: 300,
        max_output_bytes: 10485760,
        workspace_only: false,
        allow_system_paths: true,
      },
    };
    // allow_remote defaults to true (matches config/tools.yaml's shipped
    // default): an unconfigured workspace should behave exactly as it did
    // before this fix, not silently start blocking remote callers.
    const defaultExecConfig: RuntimeExecConfig = { allow_remote: true };

    if (!fs.existsSync(this.configPath)) {
      return { permissions: defaultPermissions, execConfig: defaultExecConfig };
    }

    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");
      const data = yaml.load(raw) as {
        permissions?: Permissions;
        runtime?: { exec?: RuntimeExecConfig };
      } | null;
      const permissions = data?.permissions || defaultPermissions;
      const execConfig: RuntimeExecConfig = {
        allow_remote: data?.runtime?.exec?.allow_remote ?? true,
      };
      return { permissions, execConfig };
    } catch {
      return { permissions: defaultPermissions, execConfig: defaultExecConfig };
    }
  }

  private isDisabled(level?: string): boolean {
    return ["DISABLED", "OFF", "DENY", "DENIED", "BLOCKED"].includes(
      String(level || "").toUpperCase(),
    );
  }

  public async runShell(
    command: string,
    cwd?: string,
    timeout?: number,
  ): Promise<ExecutionResult> {
    const loaded = this.loadConfig();
    this.permissions = loaded.permissions;
    this.execConfig = loaded.execConfig;
    const shellConfig = this.permissions.shell_execute || {};
    if (this.isDisabled(shellConfig.level)) {
      return {
        stdout: "",
        stderr: "",
        exitCode: -1,
        error: "shell_execute is disabled by config/tools.yaml.",
      };
    }
    // (#94) A caller with no established origin (getCallOrigin() ===
    // undefined) is treated as local -- see call-context.ts's "Coverage"
    // note for exactly which paths do and don't set this yet.
    const origin = getCallOrigin() ?? "local";
    if (this.execConfig.allow_remote === false && origin === "remote") {
      return {
        stdout: "",
        stderr: "",
        exitCode: -1,
        error:
          "shell_execute is blocked for remote callers by config/tools.yaml runtime.exec.allow_remote=false.",
      };
    }
    const maxTimeout = shellConfig.max_timeout_seconds || 300;
    const effectiveTimeout =
      timeout != null ? Math.min(timeout, maxTimeout) : maxTimeout;
    const maxBytes = shellConfig.max_output_bytes || 10485760;
    if (!command.trim()) {
      return {
        stdout: "",
        stderr: "",
        exitCode: -1,
        error: "shell_execute command is required.",
      };
    }

    let runCwd: string;
    if (cwd) {
      try {
        runCwd = path.isAbsolute(cwd) ? cwd : path.resolve(cwd);
      } catch {
        runCwd = process.cwd();
      }
    } else {
      runCwd = process.cwd();
    }

    if (!this.isDirectory(runCwd)) {
      return {
        stdout: "",
        stderr: "",
        exitCode: -1,
        error: "shell_execute cwd must be an existing directory.",
      };
    }

    try {
      const result = await execAsync(command, {
        cwd: runCwd,
        timeout: effectiveTimeout * 1000,
        maxBuffer: maxBytes + 1024,
        shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
      });

      let stdout = result.stdout || "";
      let stderr = result.stderr || "";

      if (stdout.length > maxBytes)
        stdout = stdout.slice(0, maxBytes) + "\n[Output Truncated...]";
      if (stderr.length > maxBytes)
        stderr = stderr.slice(0, maxBytes) + "\n[Error Output Truncated...]";

      const successResult = { stdout, stderr, exitCode: 0, error: "" };
      logShellEvent(command, successResult, runCwd);
      return successResult;
    } catch (err: unknown) {
      const executionError = err as ShellExecutionError;
      if (
        executionError.killed === true ||
        executionError.code === "ETIMEDOUT"
      ) {
        const partialStdout = (executionError.stdout || "").slice(0, maxBytes);
        const partialStderr = (executionError.stderr || "").slice(0, maxBytes);
        const timeoutResult = {
          stdout: partialStdout,
          stderr:
            partialStderr +
            `\nCommand execution timed out after ${effectiveTimeout} seconds.`,
          exitCode: -2,
          error: `Timeout after ${effectiveTimeout} seconds.`,
        };
        logShellEvent(command, timeoutResult, runCwd);
        return timeoutResult;
      }
      const failResult = {
        stdout: executionError.stdout || "",
        stderr: executionError.stderr || "",
        exitCode: -3,
        error: getErrorMessage(err),
      };
      logShellEvent(command, failResult, runCwd);
      return failResult;
    }
  }

  private isDirectory(targetPath: string): boolean {
    try {
      return fs.statSync(targetPath).isDirectory();
    } catch {
      return false;
    }
  }
}
