import * as fs from "fs";
import type { MemoryFilesConfig } from "./types.js";
import type { MemoryFileInfo, MemoryFileStore } from "./store.js";
import { resolveMemoryFile } from "./paths.js";

const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

interface DigestCacheEntry {
  mtimeMs: number;
  size: number;
  digest: string;
}

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * Fit a file into a prompt budget. MEMORY.md and USER.md are append-only, so the
 * newest entries sit at the END. Cutting from the end (the old behaviour) threw
 * away exactly what was learned most recently. Keep a short head (title, the
 * oldest foundational lines) and the whole recent tail, and drop the middle.
 */
function fitToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n…[middle omitted in prompt; full file on disk — use memory_get or memory_search]\n";
  const room = Math.max(0, limit - marker.length);
  const headBudget = Math.floor(room * 0.3);
  const tailBudget = room - headBudget;
  const headCut = text.slice(0, headBudget);
  const head = headCut.includes("\n") ? headCut.slice(0, headCut.lastIndexOf("\n")) : headCut;
  const tailCut = text.slice(text.length - tailBudget);
  const tail = tailCut.includes("\n") ? tailCut.slice(tailCut.indexOf("\n") + 1) : tailCut;
  return `${head}${marker}${tail}`;
}

/** Short human digest of a memory file: its title and NEWEST bullets — never the whole file. */
function digestOf(content: string, max: number): string {
  const lines = stripComments(content)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const title = lines.find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "") ?? "";
  const bullets = lines
    .filter((l) => /^[-*]\s+/.test(l) && !/^[-*]\s+(Date|Session|Trigger|Summary by):/i.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ""))
    // Notes are chronological: the latest entries are the ones worth surfacing.
    .slice(-3);
  const text = [title && !title.startsWith("Memory —") ? title : "", ...bullets]
    .filter(Boolean)
    .join(" · ");
  return oneLine(text || title, max);
}

/**
 * Builds the memory block injected at the start of every turn/session:
 *  - USER.md (stable user directives) and MEMORY.md (curated facts), each
 *    truncated in the prompt copy only with a separate bounded allowance;
 *  - an INDEX of the most recent daily notes / session summaries with a
 *    one-line digest each (not the files themselves — the agent opens them
 *    with memory_get / finds them with memory_search).
 * Results are cached by file mtime, so a quiet system costs only stat calls.
 */
export class MemoryContextBuilder {
  private digests = new Map<string, DigestCacheEntry>();

  constructor(
    private readonly store: MemoryFileStore,
    private readonly getConfig: () => MemoryFilesConfig,
  ) {}

  async build(opts: { compact?: boolean; now?: Date; trustedUser?: boolean; trustedMemory?: boolean } = {}): Promise<string> {
    const cfg = this.getConfig();
    if (!cfg.enabled) return "";
    const now = opts.now ?? new Date();
    const parts: string[] = [];
    let budget = cfg.bootstrapMaxChars;

    const userMd = opts.trustedUser === false ? "" : stripComments(await this.store.readUserMd().catch(() => ""));
    if (userMd) {
      const limit = Math.min(cfg.userMdMaxChars, budget);
      const body = fitToLimit(userMd, limit);
      parts.push(`User profile (USER.md):\n${body}`);
      budget -= body.length;
    }

    const memoryMd = opts.trustedMemory === false ? "" : stripComments(await this.store.readMemoryMd().catch(() => ""));
    if (memoryMd) {
      const limit = Math.min(cfg.memoryMdMaxChars, budget);
      const body = fitToLimit(memoryMd, limit);
      parts.push(`Long-term memory (MEMORY.md):\n${body}`);
      budget -= body.length;
    }

    if (!opts.compact && cfg.indexMaxEntries > 0 && budget > 200) {
      const index = await this.recentIndex(now, cfg, budget);
      if (index) parts.push(index);
    }

    if (parts.length === 0) return "";
    const hint = opts.compact
      ? ""
      : "\nMemory tools: memory_search (find), memory_get (read a file/lines), memory_add (save). " +
        "When the user says to remember something, save it with memory_add instead of keeping it only in this conversation.";
    return `${parts.join("\n\n")}${hint}`;
  }

  private async recentIndex(
    now: Date,
    cfg: MemoryFilesConfig,
    budget: number,
  ): Promise<string> {
    const files = await this.store.listFiles();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    cutoff.setDate(cutoff.getDate() - (cfg.recentDays - 1));
    const recent: Array<MemoryFileInfo & { date: number }> = [];
    for (const f of files) {
      if (f.rel === "MEMORY.md" || f.rel.includes("/compactions/") || f.rel.includes("/legacy-import/")) continue;
      const m = DATE_PREFIX.exec(f.rel.split("/").pop() ?? "");
      if (!m) continue;
      const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (date >= cutoff.getTime()) recent.push({ ...f, date });
    }
    recent.sort((a, b) => b.date - a.date || b.mtimeMs - a.mtimeMs);
    const lines: string[] = [];
    let used = 0;
    for (const f of recent.slice(0, cfg.indexMaxEntries)) {
      const digest = await this.digest(f);
      const line = `- ${f.rel}${digest ? ` — ${digest}` : ""}`;
      if (used + line.length > budget) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.length
      ? `Recent memory notes (index only — open with memory_get):\n${lines.join("\n")}`
      : "";
  }

  private async digest(f: MemoryFileInfo): Promise<string> {
    const cached = this.digests.get(f.abs);
    if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size) return cached.digest;
    let digest = "";
    try {
      const safeAbs = await resolveMemoryFile(this.store.paths, f.abs);
      if (!safeAbs) return "";
      digest = digestOf(await fs.promises.readFile(safeAbs, "utf-8"), 220);
    } catch {
      /* unreadable file: index it without a digest */
    }
    if (this.digests.size > 300) this.digests.clear();
    this.digests.set(f.abs, { mtimeMs: f.mtimeMs, size: f.size, digest });
    return digest;
  }
}
