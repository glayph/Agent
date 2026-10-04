import * as fs from "node:fs";
import * as path from "node:path";
import type { EngineTool } from "./types.js";
import { isSensitivePath, resolveWorkspacePath } from "./workspace-paths.js";
import { FileRunError, runWorkspaceFile, supportedRunExtensions } from "./file-runner.js";
import { errorMessage } from "./util.js";

const MAX_TREE_ENTRIES = 5_000;
const MAX_TREE_BYTES = 200 * 1024 * 1024;
const MAX_TREE_DEPTH = 24;

export interface FileToolsOptions {
  root: string;
  /** Kill switch for execution; evaluated on every call so it can be toggled at runtime. */
  executionEnabled?: () => boolean;
  allowNativeExecution?: boolean;
  /** Called after each execution so the host can keep an audit trail. */
  onRun?: (entry: { file: string; args: string[]; status: string; exitCode: number | null; durationMs: number; runId: string }) => void;
}

function str(value: unknown, name = "path"): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`"${name}" must be a non-empty string.`);
  return value;
}

function validName(name: string): string {
  if (name === "." || name === ".." || /[\\/\0]/.test(name) || name.length > 255)
    throw new Error("Name must be a plain file name without slashes.");
  return name;
}

/** Walk a tree, refusing symlinks, and enforce size/entry/depth budgets before anything is copied. */
function measureTree(source: string): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  const walk = (current: string, depth: number) => {
    if (depth > MAX_TREE_DEPTH) throw new Error("Directory tree is nested too deeply.");
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not supported.");
    entries += 1;
    if (entries > MAX_TREE_ENTRIES) throw new Error(`Tree has more than ${MAX_TREE_ENTRIES} entries.`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) walk(path.join(current, name), depth + 1);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > MAX_TREE_BYTES) throw new Error("Tree is larger than the 200 MB limit.");
    } else {
      throw new Error("Special filesystem entries are not supported.");
    }
  };
  walk(source, 0);
  return { entries, bytes };
}

function copyTree(source: string, target: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target);
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(target, name));
  } else {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
}

export function createFileManagementTools(options: FileToolsOptions): EngineTool[] {
  const root = fs.realpathSync(path.resolve(options.root));
  const rel = (abs: string) => path.relative(root, abs) || ".";
  const executionOn = () => options.executionEnabled?.() ?? true;

  const resolve = (input: unknown, name = "path"): string => {
    const abs = resolveWorkspacePath(root, str(input, name));
    if (isSensitivePath(abs))
      throw new Error("Access to credential and secret files is blocked by the workspace policy.");
    return abs;
  };
  const notRoot = (abs: string) => {
    if (abs === root) throw new Error("The workspace root cannot be modified.");
  };
  const requireExisting = (abs: string) => {
    if (!fs.existsSync(abs)) throw new Error("Path does not exist.");
  };

  /** Source and destination must both be inside the workspace and the destination must be free. */
  const transfer = (input: Record<string, unknown>, mode: "move" | "copy") => {
    const source = resolve(input.path);
    notRoot(source);
    requireExisting(source);
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error("Symbolic links are not supported.");
    const destination = resolve(input.destination, "destination");
    let target: string;
    if (fs.existsSync(destination) && fs.statSync(destination).isDirectory()) target = path.join(destination, path.basename(source));
    else target = destination;
    if (isSensitivePath(target)) throw new Error("Access to credential and secret files is blocked by the workspace policy.");
    notRoot(target);
    if (fs.existsSync(target)) throw new Error(`Target already exists: ${rel(target)}.`);
    if (!fs.existsSync(path.dirname(target))) throw new Error("Destination folder does not exist.");
    if (target === source || target.startsWith(`${source}${path.sep}`))
      throw new Error("A folder cannot be moved or copied into itself.");
    measureTree(source);
    if (mode === "copy") copyTree(source, target);
    else fs.renameSync(source, target);
    return { from: rel(source), to: rel(target) };
  };

  return [
    {
      name: "file_info",
      description: "Show type, size and modification time of a workspace file or folder.",
      risk: "read",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false },
      execute(input) {
        const abs = resolve(input.path);
        requireExisting(abs);
        const stat = fs.lstatSync(abs);
        return {
          path: rel(abs),
          type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
          sizeBytes: stat.isDirectory() ? 0 : stat.size,
          modifiedAt: stat.mtime.toISOString(),
          extension: stat.isFile() ? path.extname(abs).slice(1) : "",
          runnable: stat.isFile() && supportedRunExtensions().includes(path.extname(abs).toLowerCase()),
        };
      },
    },
    {
      name: "file_mkdir",
      description: "Create a folder (and missing parents) inside the workspace.",
      risk: "config_write",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false },
      execute(input) {
        const abs = resolve(input.path);
        notRoot(abs);
        if (fs.existsSync(abs)) {
          if (fs.statSync(abs).isDirectory()) return { path: rel(abs), created: false };
          throw new Error("A file with that name already exists.");
        }
        fs.mkdirSync(abs, { recursive: true });
        return { path: rel(abs), created: true };
      },
    },
    {
      name: "file_rename",
      description: "Rename a workspace file or folder (new name only, no path).",
      risk: "config_write",
      parameters: {
        type: "object",
        required: ["path", "newName"],
        properties: { path: { type: "string" }, newName: { type: "string" } },
        additionalProperties: false,
      },
      execute(input) {
        const source = resolve(input.path);
        notRoot(source);
        requireExisting(source);
        const target = path.join(path.dirname(source), validName(str(input.newName, "newName")));
        if (isSensitivePath(target)) throw new Error("Access to credential and secret files is blocked by the workspace policy.");
        if (fs.existsSync(target)) throw new Error(`Target already exists: ${rel(target)}.`);
        fs.renameSync(source, target);
        return { from: rel(source), to: rel(target) };
      },
    },
    {
      name: "file_move",
      description: "Move a file or folder to another workspace folder (or to a new path). Never overwrites.",
      risk: "config_write",
      parameters: {
        type: "object",
        required: ["path", "destination"],
        properties: { path: { type: "string" }, destination: { type: "string" } },
        additionalProperties: false,
      },
      execute: (input) => transfer(input, "move"),
    },
    {
      name: "file_copy",
      description: "Copy a file or folder (recursively) to another workspace location. Never overwrites.",
      risk: "config_write",
      parameters: {
        type: "object",
        required: ["path", "destination"],
        properties: { path: { type: "string" }, destination: { type: "string" } },
        additionalProperties: false,
      },
      execute: (input) => transfer(input, "copy"),
    },
    {
      name: "file_delete",
      description: "Delete a workspace file, or a folder when recursive=true. This cannot be undone.",
      risk: "destructive",
      approval: "required",
      parameters: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, recursive: { type: "boolean" } },
        additionalProperties: false,
      },
      execute(input) {
        const abs = resolve(input.path);
        notRoot(abs);
        requireExisting(abs);
        const stat = fs.lstatSync(abs);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          if (input.recursive !== true) throw new Error("recursive=true is required to delete a folder.");
          const { entries } = measureTree(abs);
          fs.rmSync(abs, { recursive: true });
          return { path: rel(abs), deleted: true, entriesRemoved: entries };
        }
        fs.rmSync(abs);
        return { path: rel(abs), deleted: true, entriesRemoved: 1 };
      },
    },
    {
      name: "file_run",
      description:
        `Run a script from the workspace and return its output (stdout, stderr, exit code). Supported types: ${supportedRunExtensions().join(", ")}. ` +
        "No shell is used; the script gets a reduced environment without secrets and a time limit. Requires the user's approval.",
      risk: "service",
      approval: "required",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          args: { type: "array", description: "Command-line arguments (strings)." },
          timeoutSeconds: { type: "integer", description: "Default 30, maximum 300." },
        },
        additionalProperties: false,
      },
      async execute(input, context) {
        if (!executionOn()) throw new Error("File execution is disabled by the workspace policy.");
        const args = Array.isArray(input.args) ? input.args.map((item) => String(item)) : [];
        const timeoutSeconds = input.timeoutSeconds === undefined ? 30 : Number(input.timeoutSeconds);
        try {
          const result = await runWorkspaceFile({
            root,
            file: str(input.path),
            args,
            timeoutMs: timeoutSeconds * 1000,
            allowNative: options.allowNativeExecution,
            signal: context.signal,
          });
          options.onRun?.({ file: result.file, args, status: result.status, exitCode: result.exitCode, durationMs: result.durationMs, runId: context.runId });
          return result;
        } catch (error) {
          if (error instanceof FileRunError) throw new Error(`${error.message} (${error.code})`);
          throw new Error(errorMessage(error));
        }
      },
    },
  ];
}
