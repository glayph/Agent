import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import type {
  SystemIndexFileInput,
  SystemIndexSearchResult,
  SystemIndexStats,
} from "./types.js";

interface CountRow {
  count: number;
}

interface StatsRow {
  indexedFiles: number;
  contentIndexedFiles: number;
  totalSizeBytes: number | null;
  lastIndexedAt: string | null;
}

interface SearchRow {
  path: string;
  name: string;
  extension: string;
  parent_path: string;
  size_bytes: number;
  modified_at_ms: number;
  indexed_at: string;
  content_indexed: number;
  snippet: string | null;
  score: number;
}

function escapeFtsToken(token: string): string {
  return token.replaceAll('"', '""');
}

function ftsQuery(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}_./:-]+/gu, ""))
    .filter(Boolean)
    .map((token) => `"${escapeFtsToken(token)}"`)
    .join(" AND ");
}

function likePattern(input: string): string {
  return `%${input.trim().replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function rowToSearchResult(row: SearchRow): SystemIndexSearchResult {
  return {
    path: row.path,
    name: row.name,
    extension: row.extension,
    parentPath: row.parent_path,
    sizeBytes: row.size_bytes,
    modifiedAt: new Date(row.modified_at_ms).toISOString(),
    indexedAt: row.indexed_at,
    contentIndexed: row.content_indexed === 1,
    snippet: row.snippet || row.name,
    score: row.score,
  };
}

export class SystemIndexDatabase {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  clear(): void {
    this.db.exec(`
      DELETE FROM system_index_fts;
      DELETE FROM system_index_files;
    `);
  }

  remove(filePath: string): void {
    const remove = this.db.transaction((target: string) => {
      this.db
        .prepare("DELETE FROM system_index_fts WHERE path = ?")
        .run(target);
      this.db
        .prepare("DELETE FROM system_index_files WHERE path = ?")
        .run(target);
    });
    remove(filePath);
  }

  upsert(file: SystemIndexFileInput): void {
    const upsert = this.db.transaction((record: SystemIndexFileInput) => {
      this.db
        .prepare(
          `INSERT INTO system_index_files (
            path, name, extension, parent_path, size_bytes, modified_at_ms,
            created_at_ms, birthtime_ms, indexed_at, content_indexed, error
          ) VALUES (
            @path, @name, @extension, @parentPath, @sizeBytes, @modifiedAtMs,
            @createdAtMs, @birthtimeMs, @indexedAt, @contentIndexed, @error
          )
          ON CONFLICT(path) DO UPDATE SET
            name = excluded.name,
            extension = excluded.extension,
            parent_path = excluded.parent_path,
            size_bytes = excluded.size_bytes,
            modified_at_ms = excluded.modified_at_ms,
            created_at_ms = excluded.created_at_ms,
            birthtime_ms = excluded.birthtime_ms,
            indexed_at = excluded.indexed_at,
            content_indexed = excluded.content_indexed,
            error = excluded.error`,
        )
        .run({
          ...record,
          contentIndexed: record.contentIndexed ? 1 : 0,
          error: record.error ?? null,
        });
      this.db
        .prepare("DELETE FROM system_index_fts WHERE path = ?")
        .run(record.path);
      this.db
        .prepare(
          `INSERT INTO system_index_fts (
            path, name, parent_path, extension, content
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          record.path,
          record.name,
          record.parentPath,
          record.extension,
          record.content,
        );
    });
    upsert(file);
  }

  stats(): SystemIndexStats {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) AS indexedFiles,
          SUM(CASE WHEN content_indexed = 1 THEN 1 ELSE 0 END) AS contentIndexedFiles,
          SUM(size_bytes) AS totalSizeBytes,
          MAX(indexed_at) AS lastIndexedAt
        FROM system_index_files`,
      )
      .get() as StatsRow;
    return {
      indexedFiles: row.indexedFiles,
      contentIndexedFiles: row.contentIndexedFiles,
      totalSizeBytes: row.totalSizeBytes ?? 0,
      lastIndexedAt: row.lastIndexedAt,
    };
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM system_index_files")
      .get() as CountRow;
    return row.count;
  }

  search(query: string, limit: number): SystemIndexSearchResult[] {
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const queryText = ftsQuery(query);
    if (!queryText) return [];

    try {
      const rows = this.db
        .prepare(
          `SELECT
            files.path,
            files.name,
            files.extension,
            files.parent_path,
            files.size_bytes,
            files.modified_at_ms,
            files.indexed_at,
            files.content_indexed,
            snippet(system_index_fts, 4, '[', ']', ' ... ', 16) AS snippet,
            bm25(system_index_fts) AS score
          FROM system_index_fts
          JOIN system_index_files AS files ON files.path = system_index_fts.path
          WHERE system_index_fts MATCH ?
          ORDER BY score ASC
          LIMIT ?`,
        )
        .all(queryText, normalizedLimit) as SearchRow[];
      return rows.map(rowToSearchResult);
    } catch {
      const pattern = likePattern(query);
      const rows = this.db
        .prepare(
          `SELECT
            path,
            name,
            extension,
            parent_path,
            size_bytes,
            modified_at_ms,
            indexed_at,
            content_indexed,
            name AS snippet,
            0 AS score
          FROM system_index_files
          WHERE name LIKE ? ESCAPE '\\'
             OR path LIKE ? ESCAPE '\\'
          ORDER BY modified_at_ms DESC
          LIMIT ?`,
        )
        .all(pattern, pattern, normalizedLimit) as SearchRow[];
      return rows.map(rowToSearchResult);
    }
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_index_files (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        extension TEXT NOT NULL,
        parent_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        modified_at_ms REAL NOT NULL,
        created_at_ms REAL NOT NULL,
        birthtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL,
        content_indexed INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS system_index_fts USING fts5(
        path,
        name,
        parent_path,
        extension,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE INDEX IF NOT EXISTS idx_system_index_files_name
        ON system_index_files(name);
      CREATE INDEX IF NOT EXISTS idx_system_index_files_extension
        ON system_index_files(extension);
      CREATE INDEX IF NOT EXISTS idx_system_index_files_modified
        ON system_index_files(modified_at_ms);
    `);
  }
}
