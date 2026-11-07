import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import type { FileMemoryService, SearchHit } from "@miki/core/memory-files";
import {
  applyRankingAdjustments,
  chunkMarkdown,
  diversifyWithMmr,
  fuseRankedPaths,
  scoreBm25,
  scoreCosine,
  redactSecrets,
  type SearchDocument,
} from "@miki/core/memory-files";

export interface MemoryEmbeddingProvider {
  readonly name: string;
  embed(text: string): Promise<ArrayLike<number>>;
}

interface ChunkRow {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  observed_at: string;
  importance: number | null;
  provenance: string;
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const EMBEDDING_COOLDOWN_MS = 60_000;
const EMBEDDING_CONCURRENCY = 4;
const semanticProvider = (name: string) =>
  name !== "hash-offline" && name !== "noop" && name !== "onnx-local";

/**
 * Durable derived index for the canonical Markdown memory files. Markdown is
 * never changed by indexing; this SQLite index can always be rebuilt.
 */
export class SqliteMemoryIndex {
  private readonly scopeId: string;
  private ftsReady = false;
  private syncPromise?: Promise<void>;
  private lastEmbeddingFailureAt = 0;
  private lastEmbeddingError?: string;
  private readonly pendingProvenance = new Map<string, { provenance: "owner" | "agent" | "untrusted"; contentHash: string }>();
  private trustFileSignature?: string;
  private trustBootstrapPromise?: Promise<{ user: boolean; memory: boolean }>;

  constructor(
    private readonly db: Database.Database,
    private readonly memory: FileMemoryService,
    private readonly embeddings: MemoryEmbeddingProvider,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.scopeId = sha256(memory.memoryPaths().root).slice(0, 24);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_file_sources (
        scope_id TEXT NOT NULL,
        path TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        provenance TEXT NOT NULL DEFAULT 'unknown',
        PRIMARY KEY(scope_id,path)
      );
      CREATE TABLE IF NOT EXISTS memory_file_chunks (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        importance REAL,
        provenance TEXT NOT NULL DEFAULT 'unknown'
      );
      CREATE INDEX IF NOT EXISTS idx_memory_file_chunks_scope_path
        ON memory_file_chunks(scope_id,path);
      CREATE TABLE IF NOT EXISTS memory_file_vectors (
        chunk_id TEXT PRIMARY KEY,
        embedding TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_file_imports (
        legacy_id TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_file_deletions (
        legacy_id TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL
      );
    `);
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_file_chunks_fts USING fts5(
          chunk_id UNINDEXED, scope_id UNINDEXED, source_path UNINDEXED, text,
          tokenize='unicode61 remove_diacritics 2'
        );
      `);
      this.ftsReady = true;
    } catch (error) {
      this.ftsReady = false;
      this.log(`Memory FTS5 unavailable; using deterministic BM25 fallback (${this.safeError(error)}).`);
    }
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/(?:sk|pk)-[A-Za-z0-9_-]{12,}/g, "[redacted]").slice(0, 180);
  }

  private initialProvenance(rel: string): string {
    const lower = rel.toLowerCase();
    if (lower.startsWith("memory/legacy-import/")) return "untrusted";
    return "unknown";
  }

  markProvenance(
    relPath: string,
    provenance: "owner" | "agent" | "untrusted",
    hadExistingContent = false,
  ): void {
    const rel = path.normalize(relPath).split(path.sep).join("/");
    if (rel.startsWith("../") || path.isAbsolute(relPath)) return;
    let contentHash: string;
    try {
      const absolute = path.resolve(this.memory.memoryPaths().root, rel);
      const root = path.resolve(this.memory.memoryPaths().root) + path.sep;
      if (!absolute.startsWith(root)) return;
      contentHash = sha256(readFileSync(absolute));
    } catch {
      // A path is only attributable after its durable bytes exist.
      return;
    }

    // File provenance represents every byte in an append-only source. A later
    // owner append must not bless older agent/imported/unknown text in the same
    // file. Keep the least-trusted provenance observed across the prior source,
    // pending writes and this write. Unknown pre-existing files fail closed.
    const prior = this.db.prepare(
      "SELECT provenance FROM memory_file_sources WHERE scope_id=? AND path=?",
    ).get(this.scopeId, rel) as { provenance: string } | undefined;
    const pending = this.pendingProvenance.get(rel);
    const rank = (value: string): number => value === "owner" ? 2 : value === "agent" ? 1 : 0;
    const normalize = (value: string): "owner" | "agent" | "untrusted" =>
      value === "owner" || value === "agent" ? value : "untrusted";
    let effective: "owner" | "agent" | "untrusted" = provenance;
    if (prior) effective = rank(normalize(prior.provenance)) < rank(effective) ? normalize(prior.provenance) : effective;
    if (pending) effective = rank(pending.provenance) < rank(effective) ? pending.provenance : effective;
    if (hadExistingContent && !prior && !pending) effective = "untrusted";

    this.pendingProvenance.set(rel, { provenance: effective, contentHash });
    // Metadata can be marked immediately only when it describes the exact bytes
    // on disk. The chunk table is updated alongside the source to keep filters aligned.
    this.db.prepare("UPDATE memory_file_sources SET provenance=? WHERE scope_id=? AND path=? AND content_hash=?")
      .run(effective, this.scopeId, rel, contentHash);
    // Do not promote stale derived chunks when the source file changed since
    // the previous index sync. The pending content hash is applied by syncFiles
    // to the newly parsed chunks only when it matches the bytes on disk.
    this.db.prepare(`UPDATE memory_file_chunks SET provenance=? WHERE scope_id=? AND path=? AND EXISTS (
      SELECT 1 FROM memory_file_sources WHERE scope_id=? AND path=? AND content_hash=?
    )`).run(effective, this.scopeId, rel, this.scopeId, rel, contentHash);
    if (rel === "USER.md" || rel === "MEMORY.md") this.trustFileSignature = undefined;
  }

  async bootstrapTrust(): Promise<{ user: boolean; memory: boolean }> {
    if (this.trustBootstrapPromise) return this.trustBootstrapPromise;
    const pending = this.bootstrapTrustInner();
    this.trustBootstrapPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.trustBootstrapPromise === pending) this.trustBootstrapPromise = undefined;
    }
  }

  private async bootstrapTrustInner(): Promise<{ user: boolean; memory: boolean }> {
    // USER.md and MEMORY.md are injected directly into prompts, so their trust
    // must be checked against their current bytes every time. mtime + size are
    // only a performance hint and can be held constant by an external edit.
    // Force only these two sources through content hashing; other daily files
    // remain on the normal incremental index path.
    await this.syncFiles(false, new Set(["USER.md", "MEMORY.md"]));
    const trustFiles = await this.memory.store.listTrustFiles();
    const signature = this.trustSignature(trustFiles);
    this.trustFileSignature = signature;
    const rows = this.db.prepare("SELECT path,provenance FROM memory_file_sources WHERE scope_id=? AND path IN ('USER.md','MEMORY.md')")
      .all(this.scopeId) as Array<{ path: string; provenance: string }>;
    const byPath = new Map(rows.map((row) => [row.path, row.provenance]));
    const present = new Set(trustFiles.map((file) => file.rel));
    return {
      user: present.has("USER.md") && byPath.get("USER.md") === "owner",
      memory: present.has("MEMORY.md") && ["owner", "agent"].includes(byPath.get("MEMORY.md") || ""),
    };
  }

  private trustSignature(files: Array<{ rel: string; mtimeMs: number; size: number }>): string {
    return files.filter((file) => file.rel === "USER.md" || file.rel === "MEMORY.md")
      .sort((a, b) => a.rel.localeCompare(b.rel))
      .map((file) => `${file.rel}:${file.mtimeMs}:${file.size}`)
      .join("|");
  }

  private async syncFiles(includeEmbeddings = true, forcePaths: ReadonlySet<string> = new Set()): Promise<void> {
    if (this.syncPromise) {
      await this.syncPromise;
      // A regular sync may have started just before a security-sensitive forced
      // read. Run the requested verification after it rather than treating the
      // in-flight scan as satisfying the force request.
      if (forcePaths.size > 0) return this.syncFiles(includeEmbeddings, forcePaths);
      return;
    }
    this.syncPromise = this.syncFilesInner(includeEmbeddings, forcePaths).finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  private async syncFilesInner(includeEmbeddings: boolean, forcePaths: ReadonlySet<string>): Promise<void> {
    const infos = await this.memory.store.listFiles();
    this.trustFileSignature = this.trustSignature(infos);
    const seen = new Set<string>();
    const readSource = this.db.prepare(
      "SELECT mtime_ms,size,content_hash,provenance FROM memory_file_sources WHERE scope_id=? AND path=?",
    );
    const readChunks = this.db.prepare(
      "SELECT id FROM memory_file_chunks WHERE scope_id=? AND path=?",
    );
    const deleteFts = this.ftsReady
      ? this.db.prepare("DELETE FROM memory_file_chunks_fts WHERE chunk_id=? AND scope_id=?")
      : undefined;
    const deleteVector = this.db.prepare("DELETE FROM memory_file_vectors WHERE chunk_id=?");
    const deleteChunk = this.db.prepare("DELETE FROM memory_file_chunks WHERE id=?");
    const deleteSource = this.db.prepare(
      "DELETE FROM memory_file_sources WHERE scope_id=? AND path=?",
    );
    const insertSource = this.db.prepare(`
      INSERT INTO memory_file_sources(scope_id,path,mtime_ms,size,content_hash,observed_at,provenance)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(scope_id,path) DO UPDATE SET mtime_ms=excluded.mtime_ms,size=excluded.size,
        content_hash=excluded.content_hash,observed_at=excluded.observed_at
    `);
    const insertChunk = this.db.prepare(`
      INSERT INTO memory_file_chunks(id,scope_id,path,start_line,end_line,text,token_count,observed_at,importance,provenance)
      VALUES(?,?,?,?,?,?,?,?,?,?)
    `);
    const insertFts = this.ftsReady
      ? this.db.prepare("INSERT INTO memory_file_chunks_fts(chunk_id,scope_id,source_path,text) VALUES(?,?,?,?)")
      : undefined;
    const replaceFile = this.db.transaction((args: {
      path: string;
      mtime: number;
      size: number;
      hash: string;
      observed: string;
      provenance: string;
      chunks: ReturnType<typeof chunkMarkdown>;
    }) => {
      const prior = readChunks.all(this.scopeId, args.path) as Array<{ id: string }>;
      for (const row of prior) {
        deleteFts?.run(row.id, this.scopeId);
        deleteVector.run(row.id);
        deleteChunk.run(row.id);
      }
      insertSource.run(
        this.scopeId,
        args.path,
        args.mtime,
        args.size,
        args.hash,
        args.observed,
        args.provenance,
      );
      for (const [chunkIndex, chunk] of args.chunks.entries()) {
        const id = sha256(`${this.scopeId}\0${args.path}\0${chunkIndex}\0${chunk.startLine}\0${args.hash}`);
        insertChunk.run(
          id,
          this.scopeId,
          args.path,
          chunk.startLine,
          chunk.endLine,
          chunk.text,
          chunk.tokenCount,
          args.observed,
          null,
          args.provenance,
        );
        insertFts?.run(id, this.scopeId, args.path, chunk.text);
      }
    });

    for (const info of infos) {
      seen.add(info.rel);
      const prior = readSource.get(this.scopeId, info.rel) as
        | { mtime_ms: number; size: number; content_hash: string; provenance: string }
        | undefined;
      const pending = this.pendingProvenance.get(info.rel);
      if (prior?.mtime_ms === info.mtimeMs && prior.size === info.size && !pending && !forcePaths.has(info.rel)) continue;
      let content: string;
      try {
        content = await fs.readFile(info.abs, "utf8");
      } catch {
        continue;
      }
      const hash = sha256(content);
      if (prior?.content_hash === hash) {
        if (pending) {
          const provenance = pending.contentHash === hash ? pending.provenance : prior.provenance;
          this.db.transaction(() => {
            this.db.prepare("UPDATE memory_file_sources SET provenance=? WHERE scope_id=? AND path=?").run(provenance, this.scopeId, info.rel);
            this.db.prepare("UPDATE memory_file_chunks SET provenance=? WHERE scope_id=? AND path=?").run(provenance, this.scopeId, info.rel);
          })();
          this.pendingProvenance.delete(info.rel);
        }
        continue;
      }
      const provenance = pending?.contentHash === hash
        ? pending.provenance
        : this.initialProvenance(info.rel);
      const chunks = chunkMarkdown(info.rel, content);
      const observed = new Date(info.mtimeMs).toISOString();
      replaceFile({
        path: info.rel,
        mtime: info.mtimeMs,
        size: info.size,
        hash,
        observed,
        provenance,
        chunks,
      });
      this.pendingProvenance.delete(info.rel);
    }
    // Drop stale provenance intents. They must never attribute later external
    // edits to the actor who wrote an earlier version of the same path.
    for (const rel of this.pendingProvenance.keys()) if (!seen.has(rel)) this.pendingProvenance.delete(rel);

    const oldSources = this.db
      .prepare("SELECT path FROM memory_file_sources WHERE scope_id=?")
      .all(this.scopeId) as Array<{ path: string }>;
    for (const row of oldSources) {
      if (seen.has(row.path)) continue;
      const prior = readChunks.all(this.scopeId, row.path) as Array<{ id: string }>;
      const removeFile = this.db.transaction(() => {
        for (const item of prior) {
          deleteFts?.run(item.id, this.scopeId);
          deleteVector.run(item.id);
          deleteChunk.run(item.id);
        }
        deleteSource.run(this.scopeId, row.path);
      });
      removeFile();
    }

    if (includeEmbeddings) await this.embedMissingChunks();
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Memory embedding timed out.")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async trustedPaths(): Promise<string[]> {
    const infos = await this.memory.store.listFiles();
    await this.syncFiles(false, new Set(infos.map((info) => info.rel)));
    return (this.db.prepare("SELECT path FROM memory_file_sources WHERE scope_id=? AND provenance IN ('owner','agent') ORDER BY path")
      .all(this.scopeId) as Array<{ path: string }>).map((row) => row.path);
  }

  /**
   * Build an immutable, hash-verified snapshot for system-prompt memory context.
   * The context builder consumes these exact bytes instead of reopening paths
   * after the trust decision (which would introduce a TOCTOU trust bypass).
   */
  async trustedContextSnapshot(): Promise<{
    user?: string;
    memory?: string;
    files: Array<{ path: string; text: string }>;
  }> {
    const infos = await this.memory.store.listFiles();
    await this.withTimeout(this.syncFiles(false, new Set(infos.map((info) => info.rel))), 15_000);
    const rows = this.db.prepare(
      "SELECT path,content_hash,provenance FROM memory_file_sources WHERE scope_id=? AND provenance IN ('owner','agent')",
    ).all(this.scopeId) as Array<{ path: string; content_hash: string; provenance: string }>;
    const trusted = new Map(rows.map((row) => [row.path, row]));
    const present = new Set(infos.map((info) => info.rel));

    const infoByPath = new Map(infos.map((info) => [info.rel, info]));
    const readVerified = async (rel: string): Promise<string | undefined> => {
      const source = trusted.get(rel);
      const info = infoByPath.get(rel);
      if (!source || !present.has(rel) || !info || info.size > 2_000_000) return undefined;
      try {
        const read = await this.memory.getFull(rel);
        if (read.error || sha256(read.text) !== source.content_hash) {
          // Fail closed now; a later index pass will mark the changed file unknown.
          await this.syncFiles(false, new Set([rel]));
          trusted.delete(rel);
          return undefined;
        }
        return read.text;
      } catch {
        return undefined;
      }
    };

    const userSource = trusted.get("USER.md");
    const memorySource = trusted.get("MEMORY.md");
    const [userText, memoryText] = await Promise.all([
      userSource?.provenance === "owner" ? readVerified("USER.md") : Promise.resolve(undefined),
      memorySource ? readVerified("MEMORY.md") : Promise.resolve(undefined),
    ]);

    const recentDays = Math.max(1, Math.min(30, this.memory.config().recentDays));
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (recentDays - 1));
    const recent = infos
      .filter((info) => {
        if (!trusted.has(info.rel) || info.rel === "MEMORY.md" || info.rel.includes("/compactions/") || info.rel.includes("/legacy-import/") || info.rel.includes("/untrusted/")) return false;
        const name = path.posix.basename(info.rel);
        const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(name);
        if (!match) return false;
        const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        return date.getTime() >= cutoff.getTime();
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.rel.localeCompare(a.rel))
      .slice(0, Math.max(0, Math.min(30, this.memory.config().indexMaxEntries)));

    const files: Array<{ path: string; text: string }> = [];
    for (const info of recent) {
      const text = await readVerified(info.rel);
      if (text !== undefined) files.push({ path: info.rel, text });
    }
    return {
      ...(userText !== undefined ? { user: userText } : {}),
      ...(memoryText !== undefined ? { memory: memoryText } : {}),
      files,
    };
  }

  /**
   * Read a trusted memory file only after rechecking its current bytes against
   * the canonical source hash. A path retrieved earlier in a run is not proof
   * that the file still contains the same trusted content.
   */
  async readTrustedFile(requested: string, from?: number, lines?: number): Promise<{
    path: string; text: string; startLine?: number; endLine?: number; error?: string;
  }> {
    const raw = typeof requested === "string" ? requested.trim().replace(/\\/g, "/") : "";
    const rel = path.posix.normalize(raw.replace(/^\.\//, ""));
    if (!raw || raw.length > 512 || rel === "." || rel.startsWith("../") || rel.startsWith("/") || rel !== raw.replace(/^\.\//, "")) {
      return { path: raw.slice(0, 512), text: "", error: "memory_get requires a safe relative memory file path." };
    }
    if (from !== undefined && (!Number.isSafeInteger(from) || from < 1)) {
      return { path: rel, text: "", error: "from must be a positive line number." };
    }
    if (lines !== undefined && (!Number.isSafeInteger(lines) || lines < 1 || lines > 500)) {
      return { path: rel, text: "", error: "lines must be between 1 and 500." };
    }

    try {
      const currentInfo = (await this.memory.store.listFiles()).find((item) => item.rel === rel);
      if (!currentInfo || currentInfo.size > 2_000_000) {
        return { path: rel, text: "", error: currentInfo ? "Memory file exceeds the safe read limit." : "Memory file was not found." };
      }
      await this.withTimeout(this.syncFiles(false, new Set([rel])), 15_000);
      const source = this.db.prepare(
        "SELECT content_hash,provenance FROM memory_file_sources WHERE scope_id=? AND path=?",
      ).get(this.scopeId, rel) as { content_hash: string; provenance: string } | undefined;
      if (!source || (source.provenance !== "owner" && source.provenance !== "agent")) {
        return { path: rel, text: "", error: "Memory file is not trusted for agent retrieval." };
      }

      // FileMemoryService.get applies the same memory-root, extension and
      // symlink checks as the normal memory_get path. Hash the exact bytes it
      // returned, then slice that verified buffer instead of reopening it.
      const read = await this.memory.getFull(rel);
      if (read.error) return read;
      if (sha256(read.text) !== source.content_hash) {
        // A concurrent edit raced the sync/read window. Fail closed; the next
        // search/get will rebuild this source as unknown provenance.
        await this.syncFiles(false, new Set([rel]));
        return { path: rel, text: "", error: "Memory file changed during authorization; search it again before reading." };
      }
      if (from === undefined && lines === undefined) {
        return read.text.length > 20_000
          ? { path: rel, text: `${read.text.slice(0, 20_000)}\n…[truncated; pass from/lines for the rest]` }
          : { path: rel, text: read.text };
      }
      const all = read.text.split(/\r?\n/);
      const start = from ?? 1;
      const count = Math.max(1, Math.min(500, lines ?? 80));
      const slice = all.slice(start - 1, start - 1 + count);
      return { path: rel, text: slice.join("\n"), startLine: start, endLine: start + slice.length - 1 };
    } catch (error) {
      return { path: rel, text: "", error: error instanceof Error ? error.message : "Memory file could not be read safely." };
    }
  }

  private async embedMissingChunks(): Promise<void> {
    if (!semanticProvider(this.embeddings.name)) return;
    if (Date.now() - this.lastEmbeddingFailureAt < EMBEDDING_COOLDOWN_MS) return;
    const rows = this.db.prepare(`
      SELECT c.id,c.text FROM memory_file_chunks c
      LEFT JOIN memory_file_vectors v ON v.chunk_id=c.id
      WHERE c.scope_id=? AND v.chunk_id IS NULL ORDER BY c.path,c.start_line LIMIT 16
    `).all(this.scopeId) as Array<{ id: string; text: string }>;
    const insertVector = this.db.prepare(`
      INSERT INTO memory_file_vectors(chunk_id,embedding,dimensions,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(chunk_id) DO UPDATE SET embedding=excluded.embedding,dimensions=excluded.dimensions,updated_at=excluded.updated_at
    `);
    for (let offset = 0; offset < rows.length; offset += EMBEDDING_CONCURRENCY) {
      const batch = rows.slice(offset, offset + EMBEDDING_CONCURRENCY);
      const results = await Promise.all(batch.map(async (row) => {
        try {
          const vector = await this.withTimeout(this.embeddings.embed(row.text.slice(0, 1_600)), 8_000);
          return { row, vector: Array.from(vector, Number) };
        } catch (error) {
          return { row, error };
        }
      }));
      for (const result of results) {
        if ("error" in result) {
          this.lastEmbeddingFailureAt = Date.now();
          this.lastEmbeddingError = this.safeError(result.error);
          this.log(`Memory embedding index update failed; keyword search remains available (${this.lastEmbeddingError}).`);
          return;
        }
        const vector = result.vector;
        if (!vector.length || vector.some((value) => !Number.isFinite(value))) continue;
        insertVector.run(result.row.id, JSON.stringify(vector), vector.length, new Date().toISOString());
      }
    }
  }

  private ftsScores(query: string, limit: number): Array<{ path: string; score: number }> {
    if (!this.ftsReady) return [];
    const terms = [...new Set(query.normalize("NFKC").replace(/[\u200c\u200d\ufeff]/g, "").match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])]
      .filter((term) => term.length > 1)
      .slice(0, 24);
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
    try {
      const rows = this.db.prepare(`
        SELECT c.id AS id,bm25(memory_file_chunks_fts) AS rank
        FROM memory_file_chunks_fts f
        JOIN memory_file_chunks c ON c.id=f.chunk_id
        WHERE memory_file_chunks_fts MATCH ? AND f.scope_id=? AND c.scope_id=?
        ORDER BY rank LIMIT ?
      `).all(match, this.scopeId, this.scopeId, Math.max(limit * 8, 100)) as Array<{ id: string; rank: number }>;
      return rows.map((row) => ({ path: row.id, score: Math.max(0, -Number(row.rank)) }));
    } catch (error) {
      this.log(`Memory FTS query failed; using in-process BM25 (${this.safeError(error)}).`);
      return [];
    }
  }

  async search(query: string, limit = 5): Promise<SearchHit[]> {
    if (typeof query !== "string") throw new Error("Memory search query must be text.");
    if (query.length > 2_000) throw new Error("Memory search query is limited to 2000 characters.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Memory search result limit must be an integer between 1 and 20.");
    const clean = query.normalize("NFKC").trim();
    if (!clean) return [];
    const boundedLimit = limit;
    // Re-hash current Markdown bytes before exposing indexed snippets. This also
    // catches same-size/same-mtime edits and prevents deleted notes resurfacing.
    const infos = await this.memory.store.listFiles();
    await this.withTimeout(this.syncFiles(false, new Set(infos.map((info) => info.rel))), 15_000);
    // Index-time vectors are best-effort. Keyword results remain available if
    // an embedding provider is slow or offline.
    try { await this.withTimeout(this.embedMissingChunks(), 10_000); }
    catch (error) { this.lastEmbeddingFailureAt = Date.now(); this.lastEmbeddingError = this.safeError(error); }
    // Unknown/imported provenance is not eligible for agent retrieval. The
    // provenance is copied from the canonical source record at indexing time.
    const rows = this.db.prepare(`
      SELECT id,path,start_line,end_line,text,observed_at,importance,provenance
      FROM memory_file_chunks
      WHERE scope_id=? AND provenance IN ('owner','agent')
    `).all(this.scopeId) as ChunkRow[];
    if (!rows.length) return [];
    const vectors = this.db.prepare(
      "SELECT chunk_id,embedding FROM memory_file_vectors WHERE chunk_id IN (SELECT id FROM memory_file_chunks WHERE scope_id=?)",
    ).all(this.scopeId) as Array<{ chunk_id: string; embedding: string }>;
    const vectorsById = new Map<string, number[]>();
    for (const row of vectors) {
      try {
        const parsed = JSON.parse(row.embedding) as unknown;
        if (Array.isArray(parsed)) vectorsById.set(row.chunk_id, parsed.map(Number));
      } catch {
        // Bad derived vectors are ignored and rebuilt on the next reindex.
      }
    }
    const documents: SearchDocument[] = rows.map((row) => ({
      id: row.id,
      path: row.path,
      text: row.text,
      ...(vectorsById.has(row.id) ? { vector: vectorsById.get(row.id) } : {}),
      ...(row.importance !== null ? { importance: row.importance } : {}),
    }));
    const keywordFts = this.ftsScores(clean, boundedLimit);
    const keywordBm25 = scoreBm25(clean, documents);
    // FTS5 supplies exact indexed matches; the shared Unicode/Bengali stemmer
    // catches suffix and spelling variants. RRF prevents either path dominating.
    const keyword = fuseRankedPaths(keywordFts, keywordBm25, { mode: "rrf", keywordWeight: 1, vectorWeight: 1 });
    let vector: Array<{ path: string; score: number }> = [];
    if (semanticProvider(this.embeddings.name) && Date.now() - this.lastEmbeddingFailureAt >= EMBEDDING_COOLDOWN_MS) {
      try {
        const queryVector = Array.from(await this.withTimeout(this.embeddings.embed(clean.slice(0, 1_600)), 8_000), Number);
        vector = scoreCosine(queryVector, documents);
        this.lastEmbeddingError = undefined;
      } catch (error) {
        this.lastEmbeddingFailureAt = Date.now();
        this.lastEmbeddingError = this.safeError(error);
        this.log(`Semantic memory search unavailable; using keyword results (${this.lastEmbeddingError}).`);
      }
    }
    const fused = fuseRankedPaths(keyword, vector, { mode: "rrf", keywordWeight: 1, vectorWeight: 1 });
    const adjusted = applyRankingAdjustments(fused, documents, clean);
    const diversified = diversifyWithMmr(adjusted, documents, { lambda: 0.7, limit: boundedLimit });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return diversified.flatMap((item) => {
      const row = byId.get(item.path);
      if (!row) return [];
      return [{
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: item.score,
        provenance: row.provenance,
        sourceReference: row.path,
        timestamp: row.observed_at,
        snippet: row.text.length > 400 ? `${row.text.slice(0, 399)}…` : row.text,
      }];
    });
  }

  async reindex(): Promise<Record<string, unknown>> {
    this.lastEmbeddingFailureAt = 0;
    this.lastEmbeddingError = undefined;
    await this.syncFiles();
    let batches = 0;
    while (semanticProvider(this.embeddings.name) && batches < 1_000) {
      const missing = Number((this.db.prepare("SELECT COUNT(*) AS n FROM memory_file_chunks c LEFT JOIN memory_file_vectors v ON v.chunk_id=c.id WHERE c.scope_id=? AND v.chunk_id IS NULL").get(this.scopeId) as { n: number }).n);
      if (!missing || this.lastEmbeddingError) break;
      await this.embedMissingChunks();
      batches++;
      if (missing > 16) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { ...this.status(), batches };
  }

  async importLegacyChunks(): Promise<number> {
    const imported = this.db.prepare(
      "SELECT legacy_id FROM memory_file_imports",
    ).all() as Array<{ legacy_id: string }>;
    const importedIds = new Set(imported.map((row) => row.legacy_id));
    const deleted = this.db.prepare("SELECT legacy_id FROM memory_file_deletions").all() as Array<{ legacy_id: string }>;
    const deletedIds = new Set(deleted.map((row) => row.legacy_id));
    const rows = this.db.prepare(`
      SELECT id,region,content,summary,provenance,confidence,importance,created_at,updated_at
      FROM memory_chunks ORDER BY created_at
    `).all() as Array<Record<string, unknown>>;
    let count = 0;
    const insertMarker = this.db.prepare(
      "INSERT OR IGNORE INTO memory_file_imports(legacy_id,imported_at) VALUES(?,?)",
    );
    for (const row of rows) {
      const legacyId = String(row.id);
      if (importedIds.has(legacyId) || deletedIds.has(legacyId)) continue;
      const filename = `${sha256(legacyId).slice(0, 32)}.md`;
      const rel = `memory/legacy-import/${filename}`;
      const abs = path.join(this.memory.memoryPaths().root, rel);
      const provenance = String(row.provenance || "unknown").replace(/[^a-z_-]/gi, "").slice(0, 30) || "unknown";
      const content = [
        `# Imported legacy memory`,
        `<!-- provenance: untrusted; legacy provenance: ${provenance} -->`,
        `- Legacy ID: ${legacyId}`,
        `- Region: ${String(row.region || "unknown")}`,
        `- Confidence: ${String(row.confidence ?? "unknown")}; importance: ${String(row.importance ?? "unknown")}`,
        `- Updated: ${String(row.updated_at || row.created_at || "unknown")}`,
        "",
        "## Summary",
        redactSecrets(String(row.summary || "")),
        "",
        "## Content",
        redactSecrets(String(row.content || "")),
        "",
      ].join("\n");
      await fs.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
      try {
        await fs.writeFile(abs, content, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      insertMarker.run(legacyId, new Date().toISOString());
      importedIds.add(legacyId);
      count++;
    }
    if (count) await this.syncFiles();
    return count;
  }

  /** Delete a legacy chunk and its derived Markdown/index copy idempotently. */
  async forgetLegacyChunk(legacyId: string): Promise<boolean> {
    const id = typeof legacyId === "string" ? legacyId.trim() : "";
    if (!id || id.length > 200) return false;
    const filename = `${sha256(id).slice(0, 32)}.md`;
    const rel = `memory/legacy-import/${filename}`;
    const absolute = path.resolve(this.memory.memoryPaths().root, rel);
    const root = path.resolve(this.memory.memoryPaths().root) + path.sep;
    if (!absolute.startsWith(root)) return false;
    const timestamp = new Date().toISOString();
    const removeRows = this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO memory_file_deletions(legacy_id,deleted_at) VALUES(?,?)").run(id, timestamp);
      this.db.prepare("DELETE FROM memory_file_imports WHERE legacy_id=?").run(id);
      this.db.prepare("DELETE FROM memory_vectors WHERE chunk_id=?").run(id);
      return this.db.prepare("DELETE FROM memory_chunks WHERE id=?").run(id).changes > 0;
    });
    const removedLegacy = removeRows();
    try { await fs.rm(absolute, { force: true }); }
    catch (error) { this.log(`Legacy memory file cleanup deferred (${this.safeError(error)}).`); }
    // This also removes FTS and semantic vectors for the now-absent source file.
    await this.syncFiles(false);
    return removedLegacy;
  }

  status(): Record<string, unknown> {
    const fileCount = this.db.prepare(
      "SELECT COUNT(*) AS n FROM memory_file_sources WHERE scope_id=?",
    ).get(this.scopeId) as { n: number };
    const chunkCount = this.db.prepare(
      "SELECT COUNT(*) AS n FROM memory_file_chunks WHERE scope_id=?",
    ).get(this.scopeId) as { n: number };
    const vectorCount = this.db.prepare(
      "SELECT COUNT(*) AS n FROM memory_file_vectors WHERE chunk_id IN (SELECT id FROM memory_file_chunks WHERE scope_id=?)",
    ).get(this.scopeId) as { n: number };
    return {
      mode: semanticProvider(this.embeddings.name) ? "hybrid" : "fts_only",
      fts5: this.ftsReady,
      sourceFiles: fileCount.n,
      chunks: chunkCount.n,
      vectors: vectorCount.n,
      embeddingProvider: this.embeddings.name,
      possibleExternalUsage: this.embeddings.name === "openai-compatible",
      embeddingStatus: this.lastEmbeddingError ? "degraded" : semanticProvider(this.embeddings.name) ? "configured" : "not_configured",
      lastEmbeddingError: this.lastEmbeddingError,
    };
  }
}
