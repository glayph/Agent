import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import * as util from "util";
import * as yaml from "js-yaml";
import { getErrorMessage } from "../../errors.js";

const execAsync = util.promisify(exec);

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

interface ShellExecutionError extends Error {
  killed?: boolean;
  code?: string | number;
  stdout?: string;
  stderr?: string;
}

export class ShellExecutor {
  public configPath: string;
  public permissions: Permissions;

  constructor(configPath: string = "config/tools.yaml") {
    this.configPath = path.resolve(configPath);
    this.permissions = this.loadConfig();
  }

  private loadConfig(): Permissions {
    const defaultPermissions: Permissions = {
      shell_execute: {
        level: "TRUSTED_FULL_ACCESS",
        max_timeout_seconds: 300,
        max_output_bytes: 10485760,
        workspace_only: false,
        allow_system_paths: true,
      },
    };

    if (!fs.existsSync(this.configPath)) return defaultPermissions;

    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");
      const data = yaml.load(raw) as { permissions?: Permissions } | null;
      if (data?.permissions) return data.permissions;
      return defaultPermissions;
    } catch {
      return defaultPermissions;
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
    this.permissions = this.loadConfig();
    const shellConfig = this.permissions.shell_execute || {};
    if (this.isDisabled(shellConfig.level)) {
      return {
        stdout: "",
        stderr: "",
        exitCode: -1,
        error: "shell_execute is disabled by config/tools.yaml.",
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

      return { stdout, stderr, exitCode: 0, error: "" };
    } catch (err: unknown) {
      const executionError = err as ShellExecutionError;
      if (
        executionError.killed === true ||
        executionError.code === "ETIMEDOUT"
      ) {
        const partialStdout = (executionError.stdout || "").slice(0, maxBytes);
        const partialStderr = (executionError.stderr || "").slice(0, maxBytes);
        return {
          stdout: partialStdout,
          stderr:
            partialStderr +
            `\nCommand execution timed out after ${effectiveTimeout} seconds.`,
          exitCode: -2,
          error: `Timeout after ${effectiveTimeout} seconds.`,
        };
      }
      return {
        stdout: executionError.stdout || "",
        stderr: executionError.stderr || "",
        exitCode: -3,
        error: getErrorMessage(err),
      };
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
