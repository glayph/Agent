import * as fs from "node:fs";
import * as path from "node:path";
import type { ControlToolFactory } from "../control/tools.js";
import type { EngineTool } from "./types.js";

// ---------------------------------------------------------------------------
// Workspace tools
// ---------------------------------------------------------------------------

export { HIDDEN_DIRS, isSensitivePath, resolveWorkspacePath } from "./workspace-paths.js";
import { HIDDEN_DIRS, isSensitivePath, resolveWorkspacePath } from "./workspace-paths.js";

export interface WorkspaceToolsOptions {
  root: string | (() => string);
  restrictToWorkspace?: boolean | (() => boolean);
  maxReadBytes?: number;
  maxListEntries?: number;
  maxSearchResults?: number;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`"${name}" must be a string.`);
  return value;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  return sample.includes(0);
}

export function createWorkspaceTools(options: WorkspaceToolsOptions): EngineTool[] {
  const getRoot = () => path.resolve(typeof options.root === "function" ? options.root() : options.root);
  const isRestricted = () => typeof options.restrictToWorkspace === "function" ? options.restrictToWorkspace() : options.restrictToWorkspace !== false;
  const resolvePath = (input: string | undefined) => {
    const root = getRoot();
    if (isRestricted()) return resolveWorkspacePath(root, input);
    const raw = input || root;
    return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  };
  const maxRead = options.maxReadBytes ?? 200_000;
  const maxList = options.maxListEntries ?? 300;
  const maxMatches = options.maxSearchResults ?? 50;
  const rel = (abs: string) => path.relative(getRoot(), abs) || ".";

  const guard = (input: unknown, name = "path"): string => {
    const raw = input === undefined ? undefined : asString(input, name);
    const abs = resolvePath(raw);
    if (isSensitivePath(abs))
      throw new Error("Access to credential and secret files is blocked by the workspace policy.");
    return abs;
  };

  return [
    {
      name: "workspace_list",
      description:
        "List files and folders in a workspace directory. Paths are relative to the workspace root.",
      risk: "read",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory, default is the workspace root." },
        },
        additionalProperties: false,
      },
      execute(input) {
        const dir = resolvePath(input.path as string | undefined);
        if (!fs.statSync(dir).isDirectory()) throw new Error("Path is not a directory.");
        const entries = fs
          .readdirSync(dir, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name));
        const shown = entries.slice(0, maxList).map((entry) => {
          const full = path.join(dir, entry.name);
          const isDir = entry.isDirectory();
          return {
            name: entry.name,
            type: isDir ? "directory" : "file",
            ...(isDir ? {} : { sizeBytes: fs.statSync(full).size }),
            ...(isSensitivePath(full) ? { restricted: true } : {}),
          };
        });
        return { path: rel(dir), total: entries.length, truncated: entries.length > maxList, entries: shown };
      },
    },
    {
      name: "file_read",
      description:
        "Read a UTF-8 text file from the workspace. Large files are truncated; use offset to continue.",
      risk: "read",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          offset: { type: "integer", description: "Byte offset to start reading from." },
          maxBytes: { type: "integer", description: "Maximum bytes to return." },
        },
        additionalProperties: false,
      },
      execute(input) {
        const file = guard(input.path);
        const info = fs.statSync(file);
        if (!info.isFile()) throw new Error("Path is not a file.");
        const offset = Math.max(0, Number(input.offset ?? 0));
        const limit = Math.min(maxRead, Math.max(1, Number(input.maxBytes ?? maxRead)));
        const fd = fs.openSync(file, "r");
        try {
          const buffer = Buffer.alloc(Math.min(limit, Math.max(0, info.size - offset)));
          const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
          const slice = buffer.subarray(0, bytes);
          if (looksBinary(slice)) throw new Error("File appears to be binary.");
          return {
            path: rel(file),
            sizeBytes: info.size,
            offset,
            truncated: offset + bytes < info.size,
            content: slice.toString("utf8"),
          };
        } finally {
          fs.closeSync(fd);
        }
      },
    },
    {
      name: "workspace_search",
      description:
        "Case-insensitive text search across workspace files. Returns file, line number and the matching line.",
      risk: "read",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          path: { type: "string", description: "Directory to search, default is the workspace root." },
          maxResults: { type: "integer" },
        },
        additionalProperties: false,
      },
      execute(input) {
        const query = asString(input.query, "query").toLowerCase();
        if (!query.trim()) throw new Error('"query" must not be empty.');
        const start = resolvePath(input.path as string | undefined);
        const limit = Math.min(maxMatches, Math.max(1, Number(input.maxResults ?? maxMatches)));
        const matches: Array<{ file: string; line: number; text: string }> = [];
        let scanned = 0;
        const walk = (dir: string): void => {
          if (matches.length >= limit || scanned > 5000) return;
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (matches.length >= limit || scanned > 5000) return;
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
              if (!HIDDEN_DIRS.has(entry.name)) walk(full);
              continue;
            }
            if (!entry.isFile() || isSensitivePath(full)) continue;
            const size = fs.statSync(full).size;
            if (size > 1_000_000) continue;
            scanned += 1;
            const buffer = fs.readFileSync(full);
            if (looksBinary(buffer)) continue;
            const lines = buffer.toString("utf8").split(/\r?\n/);
            for (let index = 0; index < lines.length; index += 1) {
              if (lines[index].toLowerCase().includes(query)) {
                matches.push({ file: rel(full), line: index + 1, text: lines[index].trim().slice(0, 200) });
                if (matches.length >= limit) return;
              }
            }
          }
        };
        if (fs.statSync(start).isDirectory()) walk(start);
        else throw new Error("Search path must be a directory.");
        return { query, scannedFiles: scanned, truncated: matches.length >= limit, matches };
      },
    },
    {
      name: "file_write",
      description:
        "Create or overwrite a UTF-8 text file in the workspace. Requires the user's approval.",
      risk: "config_write",
      approval: "required",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          overwrite: { type: "boolean", description: "Replace the file if it already exists." },
        },
        additionalProperties: false,
      },
      execute(input) {
        const file = guard(input.path);
        const content = asString(input.content, "content");
        if (Buffer.byteLength(content, "utf8") > 1_000_000)
          throw new Error("Content is larger than the 1 MB write limit.");
        if (fs.existsSync(file)) {
          if (!fs.statSync(file).isFile()) throw new Error("Path is not a file.");
          if (input.overwrite !== true)
            throw new Error("File already exists. Pass overwrite=true to replace it.");
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
        return { path: rel(file), bytesWritten: Buffer.byteLength(content, "utf8") };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Memory tools
// ---------------------------------------------------------------------------

export interface MemoryHit {
  id: string;
  text: string;
  region?: string;
  score?: number;
}

/** Storage port; the gateway backs it with SQLite, a later step can add vector search. */
export interface MemoryPort {
  search(query: string, limit: number): Promise<MemoryHit[]> | MemoryHit[];
  add(entry: { content: string; summary?: string; region?: string }): Promise<{ id: string }> | { id: string };
}

export function createMemoryTools(memory: MemoryPort): EngineTool[] {
  return [
    {
      name: "memory_search",
      description: "Search the agent's long-term memory for notes relevant to a query.",
      risk: "read",
      parameters: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" }, limit: { type: "integer" } },
        additionalProperties: false,
      },
      async execute(input) {
        const limit = Math.min(20, Math.max(1, Number(input.limit ?? 8)));
        const hits = await memory.search(asString(input.query, "query"), limit);
        return { count: hits.length, hits };
      },
    },
    {
      name: "memory_add",
      description:
        "Store a durable fact or note in long-term memory. Use only for information worth keeping across conversations.",
      risk: "config_write",
      approval: "auto",
      parameters: {
        type: "object",
        required: ["content"],
        properties: {
          content: { type: "string" },
          summary: { type: "string" },
          region: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(input) {
        const content = asString(input.content, "content").trim();
        if (!content) throw new Error('"content" must not be empty.');
        if (content.length > 4000) throw new Error("Memory entries are limited to 4000 characters.");
        return memory.add({
          content,
          summary: typeof input.summary === "string" ? input.summary : undefined,
          region: typeof input.region === "string" ? input.region : undefined,
        });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Control tools (typed, guarded system management)
// ---------------------------------------------------------------------------

/**
 * Expose the control service to the agent. The service enforces its own
 * approval policy, so these tools use origin "api": configuration changes
 * made by the agent always go through the approval queue.
 */
export function createControlTools(factory: ControlToolFactory): EngineTool[] {
  return factory.definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    risk: definition.risk,
    approval: "auto" as const,
    parameters: definition.parameters,
    execute: (input, context) =>
      factory.execute(definition.name, input, {
        origin: "api",
        actor: "agent",
        requestId: context.callId,
        sessionId: context.sessionId,
      }),
  }));
}
