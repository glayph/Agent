import * as fs from "fs";
import * as path from "path";
import type { MemoryPaths } from "./types.js";
import { isMemoryFile, relFromRoot } from "./paths.js";
import type { MemoryFileStore } from "./store.js";

interface Chunk {
  rel: string;
  startLine: number;
  endLine: number;
  text: string;
  tokens: string[];
  boost: number;
}

interface FileEntry {
  mtimeMs: number;
  size: number;
  chunks: Chunk[];
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

const TOKEN_RE = /[\p{L}\p{M}\p{N}]+/gu;
const CHUNK_TARGET = 700;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.normalize("NFKC").toLowerCase().matchAll(TOKEN_RE)) {
    const t = raw[0];
    if (t.length >= 2) out.push(t);
  }
  return out;
}

/** Split markdown into ~paragraph chunks that remember their line range. */
function chunkFile(rel: string, content: string, boost: number): Chunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let start = 1;
  let size = 0;
  const flush = (endLine: number) => {
    const text = buf.join("\n").trim();
    if (text) {
      const tokens = tokenize(text);
      if (tokens.length) chunks.push({ rel, startLine: start, endLine, text, tokens, boost });
    }
    buf = [];
    size = 0;
  };
  lines.forEach((line, i) => {
    if (buf.length === 0) start = i + 1;
    const startsBlock = /^#{1,6}\s/.test(line);
    if (startsBlock && buf.length > 0) {
      flush(i);
      start = i + 1;
    }
    buf.push(line);
    size += line.length + 1;
    if (size >= CHUNK_TARGET && line.trim() === "") flush(i + 1);
  });
  flush(lines.length);
  return chunks;
}

/**
 * Offline lexical search (BM25) over MEMORY.md and memory/**.md — the same
 * role as OpenClaw's memory_search, without needing an embedding provider
 * or network. Unicode tokenisation, so Bengali notes are searchable.
 * The index is rebuilt per file only when its mtime/size changes.
 */
export class MemorySearchIndex {
  private files = new Map<string, FileEntry>();

  constructor(private readonly store: MemoryFileStore) {}

  private async refresh(): Promise<Chunk[]> {
    const infos = await this.store.listFiles();
    const seen = new Set<string>();
    for (const info of infos) {
      seen.add(info.abs);
      const cached = this.files.get(info.abs);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) continue;
      try {
        const content = await fs.promises.readFile(info.abs, "utf-8");
        const boost = info.rel === "MEMORY.md" ? 1.25 : 1;
        this.files.set(info.abs, {
          mtimeMs: info.mtimeMs,
          size: info.size,
          chunks: chunkFile(info.rel, content, boost),
        });
      } catch {
        this.files.delete(info.abs);
      }
    }
    for (const key of [...this.files.keys()]) if (!seen.has(key)) this.files.delete(key);
    return [...this.files.values()].flatMap((f) => f.chunks);
  }

  async search(query: string, limit = 5): Promise<SearchHit[]> {
    const qTokens = [...new Set(tokenize(query))];
    if (qTokens.length === 0) return [];
    const chunks = await this.refresh();
    if (chunks.length === 0) return [];

    const N = chunks.length;
    const avgLen = chunks.reduce((s, c) => s + c.tokens.length, 0) / N || 1;
    // A query token matches a chunk token exactly, or by shared prefix (>=4 chars) for light stemming.
    const matches = (q: string, t: string) =>
      t === q || (q.length >= 4 && t.length >= 4 && (t.startsWith(q) || q.startsWith(t)) && Math.min(q.length, t.length) >= 4);
    const df = new Map<string, number>();
    const tf: Array<Map<string, number>> = chunks.map((c) => {
      const m = new Map<string, number>();
      for (const q of qTokens) {
        let count = 0;
        for (const t of c.tokens) if (matches(q, t)) count++;
        if (count) {
          m.set(q, count);
          df.set(q, (df.get(q) ?? 0) + 1);
        }
      }
      return m;
    });

    const k1 = 1.2;
    const b = 0.75;
    const hits: SearchHit[] = [];
    chunks.forEach((c, i) => {
      let score = 0;
      for (const [q, f] of tf[i]!) {
        const idf = Math.log(1 + (N - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
        score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * c.tokens.length) / avgLen));
      }
      if (score > 0) {
        // mild recency preference for dated files (newer name sorts later)
        hits.push({
          path: c.rel,
          startLine: c.startLine,
          endLine: c.endLine,
          score: Number((score * c.boost).toFixed(4)),
          snippet: c.text.length > 400 ? `${c.text.slice(0, 399)}…` : c.text,
        });
      }
    });
    hits.sort((a, b2) => b2.score - a.score || (a.path < b2.path ? 1 : -1));
    return hits.slice(0, Math.max(1, Math.min(20, limit)));
  }
}

export interface GetResult {
  path: string;
  text: string;
  startLine?: number;
  endLine?: number;
  error?: string;
}

/**
 * Targeted read of one memory file (OpenClaw's memory_get). A missing file
 * returns empty text instead of an error ("nothing recorded yet"), and
 * anything outside MEMORY.md / memory/**.md is refused.
 */
export async function readMemoryRange(
  paths: MemoryPaths,
  requested: string,
  from?: number,
  lines?: number,
): Promise<GetResult> {
  const raw = (requested || "").trim().replace(/\\/g, "/");
  const abs = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(paths.root, raw);
  if (!isMemoryFile(paths, abs))
    return {
      path: raw,
      text: "",
      error: "memory_get only reads MEMORY.md and files under memory/ (*.md).",
    };
  const rel = relFromRoot(paths, abs);
  let content: string;
  try {
    content = await fs.promises.readFile(abs, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path: rel, text: "" };
    return { path: rel, text: "", error: (err as Error).message };
  }
  if (from === undefined && lines === undefined) {
    return content.length > 20_000
      ? { path: rel, text: `${content.slice(0, 20_000)}\n…[truncated; pass from/lines for the rest]` }
      : { path: rel, text: content };
  }
  const all = content.split(/\r?\n/);
  const start = Math.max(1, Math.floor(from ?? 1));
  const count = Math.max(1, Math.min(400, Math.floor(lines ?? 80)));
  const slice = all.slice(start - 1, start - 1 + count);
  return { path: rel, text: slice.join("\n"), startLine: start, endLine: start + slice.length - 1 };
}
