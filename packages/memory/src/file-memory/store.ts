import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "node:crypto";
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
  private listing?: Promise<MemoryFileInfo[]>;

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

  async readUserMd(): Promise<string> {
    const safePath = await resolveMemoryFile(this.paths, this.paths.userMd);
    if (!safePath) throw new Error("USER.md resolves outside the memory root");
    try {
      return await fs.promises.readFile(safePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  planUserNote(text: string, now = new Date()): FileOp {
    const clean = redactSecrets(text.trim());
    return {
      path: this.paths.userMd,
      mode: "append",
      header: "# USER.md — stable user instructions\n\n",
      // FileMemoryService performs status-aware deduplication. A superseded/review
      // duplicate must be allowed to become active again after explicit owner reaffirmation.
      content: `- [observed ${formatDate(now)}; status: active; source: owner_explicit; confidence: 1.0; scope: owner] [memory_id: ${randomUUID()}] ${clean}\n`,
    };
  }

  async hasActiveUserNote(text: string): Promise<boolean> {
    const target = redactSecrets(String(text ?? "").trim()).replace(/\s+/g, " ")
    if (!target) return false
    const content = await this.readUserMd()
    return content.split(/\r?\n/).some((line) => {
      if (!/status:\s*active\b/i.test(line)) return false
      const entry = line.replace(/^- \[[^\]]+\]\s*(?:\[memory_id: [^\]]+\]\s*)?/, "").trim()
      return entry === target
    })
  }

  async supersedeUserNote(text: string, supersedes: string, now = new Date()): Promise<void> {
    const safePath = await resolveMemoryFile(this.paths, this.paths.userMd);
    if (!safePath) throw new Error("USER.md resolves outside the memory root");
    const oldDirective = supersedes.trim();
    const clean = redactSecrets(text.trim()).replace(/\s+/g, " ");
    if (!oldDirective || !clean) throw new Error("Both the replacement and exact superseded directive are required.");
    let original: string;
    try {
      original = await fs.promises.readFile(safePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("The superseded directive was not found in USER.md.");
      throw error;
    }
    const lines = original.split(/(?<=\n)/);
    const matches = lines.map((line, index) => ({ line, index })).filter(({ line }) =>
      /status:\s*(?:active|review)/i.test(line) && line.includes(oldDirective),
    );
    if (matches.length !== 1) throw new Error("The exact active directive must match exactly one USER.md entry.");
    const { line, index } = matches[0]!;
    const superseded = line.replace(/\r?\n$/, "").replace(/status:\s*(?:active|review)/i, "status: superseded");
    lines[index] = `${superseded}\n- [observed ${formatDate(now)}; status: active; source: owner_explicit; confidence: 1.0; scope: owner] [memory_id: ${randomUUID()}] ${clean}\n`;
    const temp = `${safePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(temp, lines.join(""), { flag: "wx", mode: 0o600 });
    try {
      const latest = await fs.promises.readFile(safePath, "utf8");
      if (latest !== original) throw new Error("USER.md changed concurrently; retry the preference update.");
      await fs.promises.rename(temp, safePath);
    } catch (error) {
      await fs.promises.unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Keep contradictory owner preferences visible for audit but out of active prompt context.
   * Neither statement wins automatically; both are marked review until the owner supersedes one.
   */
  async recordUserPreferenceConflict(text: string, conflictsWith: string[], now = new Date()): Promise<void> {
    const safePath = await resolveMemoryFile(this.paths, this.paths.userMd)
    if (!safePath) throw new Error("USER.md resolves outside the memory root")
    const clean = redactSecrets(text.trim()).replace(/\s+/g, " ")
    if (!clean) throw new Error("Preference conflict text is empty.")
    let original = ""
    try { original = await fs.promises.readFile(safePath, "utf8") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    const lines = original.split(/(?<=\n)/)
    const needles = [...new Set([...conflictsWith.map((item) => item.trim()).filter(Boolean), clean])]
    let currentEntryFound = false
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      const content = line.replace(/^- \[[^\]]+\]\s*(?:\[memory_id: [^\]]+\]\s*)?/, "").trim()
      if (!/status:\s*(?:active|review)/i.test(line) || !needles.includes(content)) continue
      if (content === clean) currentEntryFound = true
      lines[index] = line.replace(/status:\s*active/i, "status: review")
    }
    const reviewLine = currentEntryFound ? "" : `- [observed ${formatDate(now)}; status: review; source: owner_explicit; confidence: 0.5; scope: owner] [memory_id: ${randomUUID()}] ${clean}\n`
    const next = `${lines.join("")}${lines.length && !lines.join("").endsWith("\n") ? "\n" : ""}${original ? "" : "# USER.md — stable user instructions\n\n"}${reviewLine}`
    const temp = `${safePath}.${process.pid}.${randomUUID()}.tmp`
    await fs.promises.writeFile(temp, next, { flag: "wx", mode: 0o600 })
    try {
      const latest = await fs.promises.readFile(safePath, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "" : Promise.reject(error))
      if (latest !== original) throw new Error("USER.md changed concurrently; retry the preference conflict update.")
      await fs.promises.rename(temp, safePath)
    } catch (error) {
      await fs.promises.unlink(temp).catch(() => undefined)
      throw error
    }
  }

  /** Remove one exact owner memory entry without deleting unrelated notes. */
  async forgetEntry(scope: "user" | "long_term", text: string, status?: "active" | "draft" | "review" | "superseded"): Promise<boolean> {
    const target = redactSecrets(String(text ?? "").trim()).replace(/\s+/g, " ")
    if (!target) throw new Error("An exact memory entry is required.")
    const file = scope === "user" ? this.paths.userMd : this.paths.memoryMd
    const safePath = await resolveMemoryFile(this.paths, file)
    if (!safePath) throw new Error("Memory entry resolves outside the memory root.")
    let original: string
    try { original = await fs.promises.readFile(safePath, "utf8") }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
    const lines = original.split(/(?<=\n)/)
    const matches = lines.map((line, index) => ({ line, index })).filter(({ line }) => {
      const content = line.replace(/^- \[[^\]]+\]\s*(?:\[memory_id: [^\]]+\]\s*)?/, "").trim()
      const statusMatches = status ? new RegExp("status:\\s*" + status + "\\b", "i").test(line) : true
      return content === target && statusMatches
    })
    if (matches.length === 0) return false
    if (matches.length > 1) throw new Error("The memory text and status match multiple entries; use the memory file path to review before forgetting.")
    lines.splice(matches[0]!.index, 1)
    const temp = `${safePath}.${process.pid}.${randomUUID()}.tmp`
    await fs.promises.writeFile(temp, lines.join(""), { flag: "wx", mode: 0o600 })
    try {
      const latest = await fs.promises.readFile(safePath, "utf8")
      if (latest !== original) throw new Error("Memory file changed concurrently; retry the forget operation.")
      await fs.promises.rename(temp, safePath)
      return true
    } catch (error) {
      await fs.promises.unlink(temp).catch(() => undefined)
      throw error
    }
  }

  /** Delete one memory Markdown file after strict root/path/symlink validation. */
  async forget(relPath: string): Promise<{ path: string; deleted: boolean }> {
    const raw = String(relPath ?? "").trim().replace(/\\/g, "/")
    const normalized = path.posix.normalize(raw.replace(/^\.\//, ""))
    if (!raw || raw.length > 512 || normalized === "." || normalized.startsWith("../") || normalized.startsWith("/") || normalized !== raw.replace(/^\.\//, "")) {
      throw new Error("A safe relative memory file path is required.")
    }
    if (normalized !== "USER.md" && normalized !== "MEMORY.md" && !(normalized.startsWith("memory/") && normalized.endsWith(".md"))) {
      throw new Error("Only USER.md, MEMORY.md, and memory/**/*.md files can be forgotten.")
    }
    const absolute = path.resolve(this.paths.root, normalized)
    const safePath = await resolveMemoryFile(this.paths, absolute)
    if (!safePath) throw new Error("Memory file path is outside the memory root or uses an unsafe symlink.")
    try {
      await fs.promises.unlink(safePath)
      return { path: normalized, deleted: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: normalized, deleted: false }
      throw error
    }
  }

  /**
   * USER.md, MEMORY.md plus every markdown file under memory/ (recursive).
   * Concurrent callers share one filesystem walk; results are fresh per walk,
   * so this coalesces duplicate work without introducing a stale-file cache.
   */
  async listFiles(): Promise<MemoryFileInfo[]> {
    if (this.listing) return (await this.listing).map((file) => ({ ...file }));
    const pending = this.collectFiles();
    this.listing = pending;
    try {
      return (await pending).map((file) => ({ ...file }));
    } finally {
      if (this.listing === pending) this.listing = undefined;
    }
  }

  /**
   * List only date-prefixed notes inside the active retention window.
   * Prompt context needs recent note digests, not a full walk/stat of the whole
   * archive on every turn. Full indexing/search continues to use listFiles().
   */
  async listRecentFiles(cutoff: Date): Promise<MemoryFileInfo[]> {
    const out: MemoryFileInfo[] = [];
    const cutoffMs = new Date(cutoff.getFullYear(), cutoff.getMonth(), cutoff.getDate()).getTime();
    const datePrefix = /^(\d{4})-(\d{2})-(\d{2})/;
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const name = entry.name.toLowerCase();
          if (depth < 3 && name !== "compactions" && name !== "legacy-import")
            await walk(abs, depth + 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
        const match = datePrefix.exec(entry.name);
        if (!match) continue;
        const dateMs = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
        if (!Number.isFinite(dateMs) || dateMs < cutoffMs) continue;
        try {
          const safeAbs = await resolveMemoryFile(this.paths, abs);
          if (!safeAbs) continue;
          const st = await fs.promises.stat(safeAbs);
          if (!st.isFile()) continue;
          out.push({
            abs: safeAbs,
            rel: path.relative(this.paths.root, abs).split(path.sep).join("/"),
            mtimeMs: st.mtimeMs,
            size: st.size,
          });
        } catch {
          /* A note can disappear while the index is being assembled. */
        }
      }
    };
    await walk(this.paths.dailyDir, 0);
    return out;
  }

  /** Fast metadata check for the two trust-bearing root files; does not walk daily notes. */
  async listTrustFiles(): Promise<MemoryFileInfo[]> {
    const out: MemoryFileInfo[] = [];
    for (const abs of [this.paths.userMd, this.paths.memoryMd]) {
      try {
        const safeAbs = await resolveMemoryFile(this.paths, abs);
        if (!safeAbs) continue;
        const st = await fs.promises.stat(safeAbs);
        if (!st.isFile()) continue;
        out.push({
          abs: safeAbs,
          rel: path.relative(this.paths.root, abs).split(path.sep).join("/"),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        /* missing is fine */
      }
    }
    return out;
  }

  private async collectFiles(): Promise<MemoryFileInfo[]> {
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
    await push(this.paths.userMd);
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
