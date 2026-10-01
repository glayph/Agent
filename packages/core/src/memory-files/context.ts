import * as fs from "fs";
import type { MemoryFilesConfig } from "./types.js";
import type { MemoryFileInfo, MemoryFileStore } from "./store.js";

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

/** Short human digest of a memory file: its title/first bullets — never the whole file. */
function digestOf(content: string, max: number): string {
  const lines = stripComments(content)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const title = lines.find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "") ?? "";
  const bullets = lines
    .filter((l) => /^[-*]\s+/.test(l) && !/^[-*]\s+(Date|Session|Trigger|Summary by):/i.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ""))
    .slice(0, 3);
  const text = [title && !title.startsWith("Memory —") ? title : "", ...bullets]
    .filter(Boolean)
    .join(" · ");
  return oneLine(text || title, max);
}

/**
 * Builds the memory block injected at the start of every turn/session:
 *  - MEMORY.md (curated long-term memory), truncated in the prompt copy only;
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

  async build(opts: { compact?: boolean; now?: Date } = {}): Promise<string> {
    const cfg = this.getConfig();
    if (!cfg.enabled) return "";
    const now = opts.now ?? new Date();
    const parts: string[] = [];
    let budget = cfg.bootstrapMaxChars;

    const memoryMd = stripComments(await this.store.readMemoryMd().catch(() => ""));
    if (memoryMd) {
      const limit = Math.min(cfg.memoryMdMaxChars, budget);
      const truncated = memoryMd.length > limit;
      const body = truncated ? `${memoryMd.slice(0, limit)}\n…[truncated in prompt; full file on disk — use memory_get]` : memoryMd;
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
      : "\nMemory tools: memory_search (find), memory_get (read a file/lines), memory_note (save). " +
        "When the user says to remember something, save it with memory_note instead of keeping it only in this conversation.";
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
      if (f.rel === "MEMORY.md" || f.rel.includes("/compactions/")) continue;
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
      digest = digestOf(await fs.promises.readFile(f.abs, "utf-8"), 220);
    } catch {
      /* unreadable file: index it without a digest */
    }
    if (this.digests.size > 300) this.digests.clear();
    this.digests.set(f.abs, { mtimeMs: f.mtimeMs, size: f.size, digest });
    return digest;
  }
}
