import * as fs from "fs";
import * as path from "path";
import type { MemoryPaths } from "./types.js";
import {
  dailyFileName,
  formatDate,
  formatTime,
  sessionFileName,
  slugify,
  resolveMemoryFile,
} from "./paths.js";
import { redactSecrets } from "./redact.js";

/**
 * A planned write. Planning is pure; executing is done either
 * asynchronously (normal operation — never blocks the event loop on disk)
 * or synchronously (only during shutdown, when the process is about to
 * exit and nothing can be left pending).
 */
export interface FileOp {
  path: string;
  content: string;
  /** append: add to the file. create: write a NEW file, never overwrite. */
  mode: "append" | "create";
  /** append mode: written first when the file does not exist yet. */
  header?: string;
  /** append mode: skip the write when the file already contains this text. */
  skipIfContains?: string;
}

const MAX_UNIQUE_ATTEMPTS = 50;

function uniqueCandidate(target: string, attempt: number): string {
  if (attempt === 0) return target;
  const ext = path.extname(target);
  return `${target.slice(0, target.length - ext.length)}-${attempt + 1}${ext}`;
}

/** Normalize text for deduplication: collapse whitespace, lowercase. */
function normDedup(s: string): string {
  return s.replace(/\s+/g, " ").toLowerCase().trim();
}

/**
 * Fix #7: Improved deduplication. In addition to exact substring matching,
 * a normalized (whitespace-collapsed, lowercase) comparison catches the same
 * fact written with minor formatting differences (extra spaces, mixed case,
 * slightly different date prefixes stripped). This is a lightweight guard —
 * true semantic deduplication (same meaning, different words) requires an
 * LLM pass and is handled separately at summarization time.
 */
function shouldSkip(existing: string, op: FileOp): boolean {
  if (!op.skipIfContains) return false;
  if (existing.includes(op.skipIfContains)) return true;
  // Normalized comparison: strip whitespace and compare case-insensitively.
  const needle = normDedup(op.skipIfContains);
  if (needle.length < 10) return false; // too short to deduplicate safely
  const haystack = normDedup(existing);
  return haystack.includes(needle);
}

/** Async executor. Returns the final path, or null when the op was a no-op. */
export async function executeOp(op: FileOp): Promise<string | null> {
  await fs.promises.mkdir(path.dirname(op.path), { recursive: true });
  if (op.mode === "create") {
    for (let i = 0; i < MAX_UNIQUE_ATTEMPTS; i++) {
      const candidate = uniqueCandidate(op.path, i);
      try {
        await fs.promises.writeFile(candidate, op.content, { flag: "wx" });
        return candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new Error(`could not find a free file name near ${op.path}`);
  }
  let existing: string | null = null;
  try {
    existing = await fs.promises.readFile(op.path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing !== null && shouldSkip(existing, op)) return null;
  const prefix = existing === null && op.header ? op.header : "";
  const glue = existing !== null && existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fs.promises.appendFile(op.path, `${glue}${prefix}${op.content}`, "utf-8");
  return op.path;
}

/** Sync twin of executeOp — shutdown path only. */
export function executeOpSync(op: FileOp): string | null {
  fs.mkdirSync(path.dirname(op.path), { recursive: true });
  if (op.mode === "create") {
    for (let i = 0; i < MAX_UNIQUE_ATTEMPTS; i++) {
      const candidate = uniqueCandidate(op.path, i);
      try {
        fs.writeFileSync(candidate, op.content, { flag: "wx" });
        return candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new Error(`could not find a free file name near ${op.path}`);
  }
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(op.path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing !== null && shouldSkip(existing, op)) return null;
  const prefix = existing === null && op.header ? op.header : "";
  const glue = existing !== null && existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(op.path, `${glue}${prefix}${op.content}`, "utf-8");
  return op.path;
}

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function bullet(text: string): string {
  const [first = "", ...rest] = redactSecrets(text).trim().split(/\r?\n/);
  return [`- ${first}`, ...rest.map((l) => `  ${l}`)].join("\n");
}

export interface MemoryFileInfo {
  abs: string;
  rel: string;
  mtimeMs: number;
  size: number;
}

export class MemoryFileStore {
  constructor(readonly paths: MemoryPaths) {}

  // ---- planning (pure) ---------------------------------------------------

  planDailyNote(text: string, source = "agent", now = new Date()): FileOp {
    const file = path.join(this.paths.dailyDir, dailyFileName(now));
    return {
      path: file,
      mode: "append",
      header: `# Memory — ${formatDate(now)}\n\n`,
      content: `${bullet(`${formatTime(now)} [${source}] ${text.trim()}`)}\n`,
    };
  }

  planLongTermNote(text: string, now = new Date()): FileOp {
    const clean = redactSecrets(text.trim());
    return {
      path: this.paths.memoryMd,
      mode: "append",
      header: "# MEMORY.md — curated long-term memory\n\n",
      skipIfContains: clean,
      content: `${bullet(`[${formatDate(now)}] ${clean}`)}\n`,
    };
  }

  planSessionSummary(input: {
    sessionId: string;
    title: string;
    summary: string;
    reason: string;
    via: "llm" | "heuristic";
    now?: Date;
  }): FileOp {
    const now = input.now ?? new Date();
    const slug = slugify(input.title);
    const body = redactSecrets(input.summary.trim());
    return {
      path: path.join(this.paths.dailyDir, sessionFileName(now, slug)),
      mode: "create",
      content:
        `# Session: ${oneLine(input.title, 120)}\n\n` +
        `- Date: ${formatDate(now)} ${formatTime(now)}\n` +
        `- Session: ${input.sessionId}\n` +
        `- Trigger: ${input.reason}\n` +
        `- Summary by: ${input.via}\n\n${body}\n`,
    };
  }

  compactionArchivePath(sessionId: string, now = new Date()): string {
    const sid = slugify(sessionId, 8);
    return path.join(this.paths.compactionDir, `${formatDate(now)}-${sid}.md`);
  }

  planCompactionArchive(input: {
    sessionId: string;
    summary: string;
    archivedCount: number;
    now?: Date;
  }): FileOp {
    const now = input.now ?? new Date();
    return {
      path: this.compactionArchivePath(input.sessionId, now),
      mode: "append",
      header: `# Compaction archive — session ${input.sessionId} (${formatDate(now)})\n\n`,
      content:
        `## ${formatTime(now)} — ${input.archivedCount} earlier messages compacted\n\n` +
        `${redactSecrets(input.summary.trim())}\n\n`,
    };
  }

  // ---- reading -----------------------------------------------------------

  async readMemoryMd(): Promise<string> {
    const safePath = await resolveMemoryFile(this.paths, this.paths.memoryMd);
    if (!safePath) throw new Error("MEMORY.md resolves outside the memory root");
    try {
      return await fs.promises.readFile(safePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  /** MEMORY.md plus every markdown file under memory/ (recursive). */
  async listFiles(): Promise<MemoryFileInfo[]> {
    const out: MemoryFileInfo[] = [];
    const push = async (abs: string) => {
      try {
        const safeAbs = await resolveMemoryFile(this.paths, abs);
        if (!safeAbs) return;
        const st = await fs.promises.stat(safeAbs);
        if (st.isFile()) {
          out.push({
            abs: safeAbs,
            rel: path.relative(this.paths.root, abs).split(path.sep).join("/"),
            mtimeMs: st.mtimeMs,
            size: st.size,
          });
        }
      } catch {
        /* missing is fine */
      }
    };
    await push(this.paths.memoryMd);
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 3) await walk(abs, depth + 1);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
          await push(abs);
      }
    };
    await walk(this.paths.dailyDir, 0);
    return out;
  }
}
