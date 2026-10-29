import * as fs from "node:fs";
import * as path from "node:path";
import type { EngineTool } from "./types.js";
import { resolveWorkspacePath } from "./workspace-paths.js";
import { FileRunError, runWorkspaceFile, supportedRunExtensions } from "./file-runner.js";
import { errorMessage } from "./util.js";

const DEFAULT_TREE_ENTRIES = Number.POSITIVE_INFINITY;
const DEFAULT_TREE_BYTES = Number.POSITIVE_INFINITY;
const DEFAULT_TREE_DEPTH = Number.POSITIVE_INFINITY;
const DEFAULT_READ_BYTES = Number.MAX_SAFE_INTEGER;

export interface FileToolsOptions {
  root: string | (() => string);
  restrictToWorkspace?: boolean | (() => boolean);
  /** Kill switch for execution; evaluated on every call so it can be toggled at runtime. */
  executionEnabled?: () => boolean;
  allowNativeExecution?: boolean;
  /** Optional per-operation safety caps. Unset means no artificial size/count cap. */
  maxTreeEntries?: number;
  maxTreeBytes?: number;
  maxTreeDepth?: number;
  maxReadBytes?: number;
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
function measureTree(source: string, limits: { entries: number; bytes: number; depth: number }): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  const walk = (current: string, depth: number) => {
    if (depth > limits.depth) throw new Error(`Directory tree exceeds configured depth limit (${limits.depth}).`);
    const stat = fs.lstatSync(current);
    entries += 1;
    if (entries > limits.entries) throw new Error(`Tree exceeds configured entry limit (${limits.entries}).`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) walk(path.join(current, name), depth + 1);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > limits.bytes) throw new Error(`Tree exceeds configured byte limit (${limits.bytes}).`);
    } else {
      throw new Error("Symbolic links and other special filesystem entries are not supported.");
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
  const getRoot = () => {
    const configured = typeof options.root === "function" ? options.root() : options.root;
    return fs.realpathSync(path.resolve(configured));
  };
  const isRestricted = () =>
    typeof options.restrictToWorkspace === "function"
      ? options.restrictToWorkspace()
      : options.restrictToWorkspace !== false;
  const rel = (abs: string) => path.relative(getRoot(), abs) || ".";
  const executionOn = () => options.executionEnabled?.() ?? true;
  const treeLimits = {
    entries: options.maxTreeEntries ?? DEFAULT_TREE_ENTRIES,
    bytes: options.maxTreeBytes ?? DEFAULT_TREE_BYTES,
    depth: options.maxTreeDepth ?? DEFAULT_TREE_DEPTH,
  };
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_READ_BYTES;

  const resolve = (input: unknown, name = "path"): string => {
    const root = getRoot();
    const raw = str(input, name);
    const abs = isRestricted()
      ? resolveWorkspacePath(root, raw)
      : path.isAbsolute(raw)
        ? path.resolve(raw)
        : path.resolve(root, raw);
    return abs;
  };
  const notRoot = (_abs: string) => {
    const root = getRoot();
    void root; // the workspace root may be modified
  };
  const requireExisting = (abs: string) => {
    if (!fs.existsSync(abs)) throw new Error("Path does not exist.");
  };

  /** Source and destination must both be inside the workspace and the destination must be free. */
  const transfer = (input: Record<string, unknown>, mode: "move" | "copy") => {
    const source = resolve(input.path);
    notRoot(source);
    requireExisting(source);
    const destination = resolve(input.destination, "destination");
    let target: string;
    if (fs.existsSync(destination) && fs.statSync(destination).isDirectory()) target = path.join(destination, path.basename(source));
    else target = destination;
    notRoot(target);
    if (fs.existsSync(target)) throw new Error(`Target already exists: ${rel(target)}.`);
    if (!fs.existsSync(path.dirname(target))) throw new Error("Destination folder does not exist.");
    if (target === source || target.startsWith(`${source}${path.sep}`))
      throw new Error("A folder cannot be moved or copied into itself.");
    measureTree(source, treeLimits);
    if (mode === "copy") copyTree(source, target);
    else fs.renameSync(source, target);
    return { from: rel(source), to: rel(target) };
  };

  return [
    {
      name: "file_read",
      description: "Read a UTF-8 text file from the workspace.",
      risk: "read",
      parameters: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, offset: { type: "integer" }, maxBytes: { type: "integer" } },
        additionalProperties: false,
      },
      async execute(input) {
        const file = resolve(input.path);
        requireExisting(file);
        const info = fs.statSync(file);
        if (!info.isFile()) throw new Error("Path is not a file.");
        const offset = Math.max(0, Number(input.offset ?? 0));
        const requested = Number(input.maxBytes ?? maxReadBytes);
        const limit = Math.min(maxReadBytes, Math.max(1, Number.isFinite(requested) ? requested : maxReadBytes));
        const fd = fs.openSync(file, "r");
        try {
          const buffer = Buffer.alloc(Math.min(limit, Math.max(0, info.size - offset)));
          const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
          const content = buffer.subarray(0, bytes).toString("utf8");
          if (content.includes("\u0000")) throw new Error("File appears to be binary.");
          return { path: rel(file), sizeBytes: info.size, offset, truncated: offset + bytes < info.size, content };
        } finally {
          fs.closeSync(fd);
        }
      },
    },
    {
      name: "file_info",
      description: "Show type, size and modification time of a workspace file or folder.",
      risk: "read",
      parallelSafe: true,
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
      approval: "auto",
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
      approval: "auto",
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
        if (fs.existsSync(target)) throw new Error(`Target already exists: ${rel(target)}.`);
        fs.renameSync(source, target);
        return { from: rel(source), to: rel(target) };
      },
    },
    {
      name: "file_move",
      description: "Move a file or folder to another workspace folder (or to a new path). Never overwrites.",
      risk: "config_write",
      approval: "auto",
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
      approval: "auto",
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
          const { entries } = measureTree(abs, treeLimits);
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
            root: getRoot(),
            file: str(input.path),
            restrictToRoot: isRestricted(),
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
