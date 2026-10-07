import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
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

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
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
  private readonly pendingProvenance = new Map<string, "owner" | "agent">();

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

  markProvenance(relPath: string, provenance: "owner" | "agent"): void {
    const rel = path.normalize(relPath).split(path.sep).join("/");
    if (rel.startsWith("../") || path.isAbsolute(relPath)) return;
    this.pendingProvenance.set(rel, provenance);
    this.db.prepare("UPDATE memory_file_sources SET provenance=? WHERE scope_id=? AND path=?")
      .run(provenance, this.scopeId, rel);
  }

  async bootstrapTrust(): Promise<{ user: boolean; memory: boolean }> {
    await this.syncFiles(false);
    const rows = this.db.prepare("SELECT path,provenance FROM memory_file_sources WHERE scope_id=? AND path IN ('USER.md','MEMORY.md')")
      .all(this.scopeId) as Array<{ path: string; provenance: string }>;
    const byPath = new Map(rows.map((row) => [row.path, row.provenance]));
    return {
      user: byPath.get("USER.md") === "owner",
      memory: ["owner", "agent"].includes(byPath.get("MEMORY.md") || ""),
    };
  }

  private async syncFiles(includeEmbeddings = true): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.syncFilesInner(includeEmbeddings).finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  private async syncFilesInner(includeEmbeddings: boolean): Promise<void> {
    const infos = await this.memory.store.listFiles();
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
      if (prior?.mtime_ms === info.mtimeMs && prior.size === info.size) continue;
      let content: string;
      try {
        content = await fs.readFile(info.abs, "utf8");
      } catch {
        continue;
      }
      const hash = sha256(content);
      if (prior?.content_hash === hash) continue;
      const provenance = this.pendingProvenance.get(info.rel) || prior?.provenance || this.initialProvenance(info.rel);
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
          return { row, vector: Array.from(await this.embeddings.embed(row.text), Number) };
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
    const terms = [...new Set(query.normalize("NFKC").match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])]
      .filter((term) => term.length > 1)
      .slice(0, 16);
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
    const clean = query.trim();
    if (!clean) return [];
    await this.syncFiles();
    const rows = this.db.prepare(`
      SELECT id,path,start_line,end_line,text,observed_at,importance,provenance
      FROM memory_file_chunks WHERE scope_id=?
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
    let keyword = this.ftsScores(clean, limit);
    if (!keyword.length) keyword = scoreBm25(clean, documents);
    let vector: Array<{ path: string; score: number }> = [];
    if (semanticProvider(this.embeddings.name) && Date.now() - this.lastEmbeddingFailureAt >= EMBEDDING_COOLDOWN_MS) {
      try {
        const queryVector = Array.from(await this.embeddings.embed(clean), Number);
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
    const diversified = diversifyWithMmr(adjusted, documents, { lambda: 0.7, limit: Math.min(20, Math.max(1, limit)) });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return diversified.flatMap((item) => {
      const row = byId.get(item.path);
      if (!row) return [];
      return [{
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: item.score,
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
      if (importedIds.has(legacyId)) continue;
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
