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
  enable_deny_patterns?: boolean;
  custom_allow_patterns?: string[];
  custom_deny_patterns?: string[];
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
  private workspaceRoot: string | null = null;
  private workspaceRealRoot: string | null = null;

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
      const rawExec = data?.runtime?.exec || {};
      const toPatterns = (value: unknown): string[] =>
        Array.isArray(value)
          ? value.filter(
              (item): item is string =>
                typeof item === "string" && item.trim().length > 0,
            )
          : [];
      const execConfig: RuntimeExecConfig = {
        allow_remote: rawExec.allow_remote ?? true,
        enable_deny_patterns: rawExec.enable_deny_patterns ?? false,
        custom_allow_patterns: toPatterns(rawExec.custom_allow_patterns),
        custom_deny_patterns: toPatterns(rawExec.custom_deny_patterns),
      };
      return { permissions, execConfig };
    } catch {
      return { permissions: defaultPermissions, execConfig: defaultExecConfig };
    }
  }

  public setWorkspaceRoot(root: string): void {
    const trimmed = root.trim();
    this.workspaceRoot = trimmed ? path.resolve(trimmed) : null;
    this.workspaceRealRoot = this.workspaceRoot
      ? this.realpathIfAvailable(this.workspaceRoot)
      : null;
  }

  private realpathIfAvailable(target: string): string {
    try {
      return fs.realpathSync.native(target);
    } catch {
      return path.resolve(target);
    }
  }

  private isWithinWorkspace(candidate: string): boolean {
    if (!this.workspaceRoot) return true;
    const realCandidate = this.realpathIfAvailable(candidate);
    const root = this.workspaceRealRoot || this.workspaceRoot;
    const relative = path.relative(root, realCandidate);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
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
    const deniedPatterns = this.execConfig.enable_deny_patterns
      ? this.execConfig.custom_deny_patterns || []
      : [];
    if (
      deniedPatterns.some((pattern) => this.matchesPattern(command, pattern))
    ) {
      return {
        stdout: "",
        stderr: "",
        exitCode: -1,
        error:
          "shell_execute command denied by runtime.exec.custom_deny_patterns.",
      };
    }
    const allowedPatterns = this.execConfig.custom_allow_patterns || [];
    if (
      allowedPatterns.length > 0 &&
      !allowedPatterns.some((pattern) => this.matchesPattern(command, pattern))
    ) {
      return {
        stdout: "",
        stderr: "",
        exitCode: -1,
        error:
          "shell_execute command is not included in runtime.exec.custom_allow_patterns.",
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
        runCwd = path.isAbsolute(cwd)
          ? path.resolve(cwd)
          : path.resolve(this.workspaceRoot || process.cwd(), cwd);
      } catch {
        runCwd = process.cwd();
      }
    } else {
      runCwd = this.workspaceRoot || process.cwd();
    }

    if (!this.isWithinWorkspace(runCwd)) {
      return {
        stdout: "",
        stderr: "",
        exitCode: -1,
        error: "shell_execute cwd must remain inside the active workspace.",
      };
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

  private matchesPattern(command: string, pattern: string): boolean {
    const source = pattern.trim();
    if (!source) return false;
    if (
      source.length > 2 &&
      source.startsWith("/") &&
      source.lastIndexOf("/") > 0
    ) {
      const end = source.lastIndexOf("/");
      try {
        return new RegExp(source.slice(1, end), source.slice(end + 1)).test(
          command,
        );
      } catch {
        return false;
      }
    }
    const escaped = source.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const glob = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
    try {
      return new RegExp(`^${glob}$`).test(command.trim());
    } catch {
      return false;
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
