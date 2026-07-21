import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { getErrorMessage } from "../../errors.js";

interface PermissionConfig {
  level?: string;
  workspace_only?: boolean;
  allow_absolute_paths?: boolean;
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

  private _resolvePath(pathStr: string): string {
    return path.resolve(pathStr);
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
    if (this.isDisabled(config.permissions?.[toolName]?.level)) {
      return `${toolName} is disabled by config/tools.yaml.`;
    }
    return true;
  }

  public readFile(pathStr: string): string {
    const allowed = this.isAllowed("file_read");
    if (allowed !== true) return `Error: ${allowed}`;
    try {
      const p = this._resolvePath(pathStr);
      if (!fs.existsSync(p)) return `Error: File '${pathStr}' does not exist.`;
      const stat = fs.statSync(p);
      if (!stat.isFile())
        return `Error: Path '${pathStr}' is a directory, not a file.`;
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
        return `Error: File '${pathStr}' exceeds the configured max_file_size_mb limit.`;
      }
      return fs.readFileSync(p, { encoding: "utf-8" });
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      console.error(`[FileSecurityExecutor] Failed to read file: ${message}`);
      return `Error: Failed to read file: ${message}`;
    }
  }

  public writeFile(pathStr: string, content: string): string {
    const allowed = this.isAllowed("file_write");
    if (allowed !== true) return `Error: ${allowed}`;
    try {
      const p = this._resolvePath(pathStr);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, { encoding: "utf-8" });
      return `Success: File written to '${pathStr}' successfully.`;
    } catch (err: unknown) {
      return `Error: Failed to write file: ${getErrorMessage(err)}`;
    }
  }

  public deleteFile(pathStr: string, dryRun: boolean = false): string {
    const allowed = this.isAllowed("file_delete");
    if (allowed !== true) return `Error: ${allowed}`;
    try {
      const p = this._resolvePath(pathStr);
      if (!fs.existsSync(p)) return `Error: File '${pathStr}' does not exist.`;
      if (dryRun) return `[DRY-RUN] Would delete: ${pathStr}`;
      if (fs.statSync(p).isFile()) {
        fs.unlinkSync(p);
        return `Success: File '${pathStr}' deleted.`;
      } else if (fs.statSync(p).isDirectory()) {
        return `Error: Path '${pathStr}' is a directory. Use shell_execute to remove directories.`;
      }
      return `Error: Unsupported path type.`;
    } catch (err: unknown) {
      return `Error: Failed to delete file: ${getErrorMessage(err)}`;
    }
  }
}
