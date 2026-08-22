import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { getErrorMessage } from "../../errors.js";
import { getMemory } from "../../memory/memory-bridge.js";
import { getCallOrigin } from "./call-context.js";

// Log a file tool event to long-term memory — fully defensive, never throws.
function logFileEvent(
  tool: "file_read" | "file_write" | "file_delete",
  filePath: string,
  outcome: "success" | "failed" | "denied",
  detail?: string,
): void {
  const memory = getMemory();
  if (!memory) return;
  try {
    memory.logToolCall(
      tool,
      { path: filePath },
      { outcome, detail: detail || undefined },
    );
  } catch {
    // Memory write failure must never affect file operations
  }
}

interface PermissionConfig {
  level?: string;
  workspace_only?: boolean;
  allow_absolute_paths?: boolean;
  allow_remote?: boolean;
  max_file_size_mb?: number;
  allow_system_paths?: boolean;
}

interface ToolsConfig {
  permissions?: Record<string, PermissionConfig>;
  tool_state?: Record<string, boolean>;
  disabled_tools?: string[];
}

export class FileSecurityExecutor {
  public configPath: string;
  public systemRoots: string[];
  private workspaceRoot: string | null = null;
  private workspaceRealRoot: string | null = null;

  constructor(configPath: string = "config/tools.yaml") {
    this.configPath = path.resolve(configPath);
    this.systemRoots = this.detectSystemRoots();
  }

  private detectSystemRoots(): string[] {
    const roots: string[] = [];
    if (process.platform === "win32") {
      for (let code = 65; code <= 90; code++) {
        const drive = `${String.fromCharCode(code)}:\\`;
        if (fs.existsSync(drive)) roots.push(drive);
      }
    } else {
      roots.push("/");
    }
    return roots;
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

  private nearestExistingRealPath(target: string): string {
    let probe = path.resolve(target);
    const suffix: string[] = [];
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      suffix.unshift(path.basename(probe));
      probe = parent;
    }
    return path.resolve(this.realpathIfAvailable(probe), ...suffix);
  }

  private _resolvePath(pathStr: string): string {
    const base = this.workspaceRoot || process.cwd();
    const resolved = path.isAbsolute(pathStr)
      ? path.resolve(pathStr)
      : path.resolve(base, pathStr);
    if (this.workspaceRoot) {
      const boundaryTarget = this.nearestExistingRealPath(resolved);
      const root = this.workspaceRealRoot || this.workspaceRoot;
      const relative = path.relative(root, boundaryTarget);
      const outside = relative.startsWith("..") || path.isAbsolute(relative);
      if (outside) {
        throw new Error("path must remain inside the active workspace");
      }
    }
    return resolved;
  }

  private loadConfig(): ToolsConfig {
    if (!fs.existsSync(this.configPath)) return {};
    try {
      return (yaml.load(fs.readFileSync(this.configPath, "utf-8")) ||
        {}) as ToolsConfig;
    } catch {
      return {};
    }
  }

  private isDisabled(level?: string): boolean {
    return ["DISABLED", "OFF", "DENY", "DENIED", "BLOCKED"].includes(
      String(level || "").toUpperCase(),
    );
  }

  private isAllowed(
    toolName: "file_read" | "file_write" | "file_delete",
  ): true | string {
    const config = this.loadConfig();
    if (config.tool_state?.[toolName] === false) {
      return `${toolName} is disabled by config/tools.yaml.`;
    }
    if (config.disabled_tools?.includes(toolName)) {
      return `${toolName} is disabled by config/tools.yaml.`;
    }
    const permission = config.permissions?.[toolName] || {};
    if (this.isDisabled(permission.level)) {
      return `${toolName} is disabled by config/tools.yaml.`;
    }
    if (
      getCallOrigin() === "remote" &&
      toolName !== "file_read" &&
      permission.allow_remote !== true
    ) {
      return `${toolName} is blocked for remote callers; set permissions.${toolName}.allow_remote=true to allow it.`;
    }
    return true;
  }

  public readFile(pathStr: string): string {
    const allowed = this.isAllowed("file_read");
    if (allowed !== true) {
      logFileEvent("file_read", pathStr, "denied", allowed);
      return `Error: ${allowed}`;
    }
    try {
      const p = this._resolvePath(pathStr);
      if (!fs.existsSync(p)) {
        logFileEvent("file_read", pathStr, "failed", "file does not exist");
        return `Error: File '${pathStr}' does not exist.`;
      }
      const stat = fs.statSync(p);
      if (!stat.isFile()) {
        logFileEvent("file_read", pathStr, "failed", "path is a directory");
        return `Error: Path '${pathStr}' is a directory, not a file.`;
      }
      const permission = this.loadConfig().permissions?.file_read || {};
      const maxFileSizeMb =
        typeof permission.max_file_size_mb === "number"
          ? permission.max_file_size_mb
          : undefined;
      if (
        maxFileSizeMb !== undefined &&
        maxFileSizeMb >= 0 &&
        stat.size > maxFileSizeMb * 1024 * 1024
      ) {
        logFileEvent(
          "file_read",
          pathStr,
          "failed",
          "exceeds max_file_size_mb",
        );
        return `Error: File '${pathStr}' exceeds the configured max_file_size_mb limit.`;
      }
      const content = fs.readFileSync(p, { encoding: "utf-8" });
      logFileEvent("file_read", pathStr, "success");
      return content;
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      console.error(`[FileSecurityExecutor] Failed to read file: ${message}`);
      logFileEvent("file_read", pathStr, "failed", message);
      return `Error: Failed to read file: ${message}`;
    }
  }

  public writeFile(pathStr: string, content: string): string {
    const allowed = this.isAllowed("file_write");
    if (allowed !== true) {
      logFileEvent("file_write", pathStr, "denied", allowed);
      return `Error: ${allowed}`;
    }
    try {
      const p = this._resolvePath(pathStr);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, { encoding: "utf-8" });
      logFileEvent("file_write", pathStr, "success");
      return `Success: File written to '${pathStr}' successfully.`;
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      logFileEvent("file_write", pathStr, "failed", message);
      return `Error: Failed to write file: ${message}`;
    }
  }

  public deleteFile(pathStr: string, dryRun: boolean = false): string {
    const allowed = this.isAllowed("file_delete");
    if (allowed !== true) {
      logFileEvent("file_delete", pathStr, "denied", allowed);
      return `Error: ${allowed}`;
    }
    try {
      const p = this._resolvePath(pathStr);
      if (!fs.existsSync(p)) {
        logFileEvent("file_delete", pathStr, "failed", "file does not exist");
        return `Error: File '${pathStr}' does not exist.`;
      }
      if (dryRun) return `[DRY-RUN] Would delete: ${pathStr}`;
      if (fs.statSync(p).isFile()) {
        fs.unlinkSync(p);
        logFileEvent("file_delete", pathStr, "success");
        return `Success: File '${pathStr}' deleted.`;
      } else if (fs.statSync(p).isDirectory()) {
        logFileEvent("file_delete", pathStr, "failed", "path is a directory");
        return `Error: Path '${pathStr}' is a directory. Use shell_execute to remove directories.`;
      }
      return `Error: Unsupported path type.`;
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      logFileEvent("file_delete", pathStr, "failed", message);
      return `Error: Failed to delete file: ${message}`;
    }
  }
}
