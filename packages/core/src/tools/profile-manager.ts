import * as path from "path";
import * as fs from "fs";

export interface BrowserProfileEntry {
  id: string;
  path: string;
  created_at: string;
  last_used_at: string;
  size_bytes: number;
  marked_for_cleanup: number;
}

interface ProfileDatabase {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): unknown;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

export class ProfileManager {
  private readonly ttlDays: number;
  private readonly cleanupIntervalMs: number;
  private activeProfileId: string | null = null;
  private _lastCleanupRun = 0;
  private _db: ProfileDatabase;

  constructor(
    db: ProfileDatabase,
    opts: {
      ttlDays?: number;
      cleanupIntervalHours?: number;
      maxSizeMB?: number;
    } = {},
  ) {
    this._db = db;
    this.ttlDays = opts.ttlDays ?? 7;
    this.cleanupIntervalMs = (opts.cleanupIntervalHours ?? 1) * 3600 * 1000;
    this.ensureSchema();
  }

  private ensureSchema() {
    try {
      this._db.exec(
        "CREATE TABLE IF NOT EXISTS browser_profiles (" +
          "  id               TEXT PRIMARY KEY," +
          "  path             TEXT NOT NULL," +
          "  created_at       TEXT NOT NULL," +
          "  last_used_at     TEXT NOT NULL," +
          "  size_bytes       INTEGER DEFAULT 0," +
          "  marked_for_cleanup INTEGER DEFAULT 0" +
          ")",
      );
    } catch (err) {
      console.warn(`[ProfileManager] ensureSchema failed:`, err);
    }
  }

  register(profileId: string, profilePath: string) {
    const now = new Date().toISOString();
    try {
      this._db.run(
        "INSERT INTO browser_profiles (id, path, created_at, last_used_at, size_bytes, marked_for_cleanup)" +
          " VALUES (?, ?, ?, ?, COALESCE((SELECT size_bytes FROM browser_profiles WHERE id = ?), 0), 0)" +
          " ON CONFLICT(id) DO UPDATE SET" +
          "   path = excluded.path," +
          "   last_used_at = excluded.last_used_at",
        [profileId, profilePath, now, now, profileId],
      );
    } catch (err) {
      console.warn(`[ProfileManager] register failed:`, err);
    }
    this._updateSize(profileId, profilePath);
  }

  markActive(profileId: string) {
    this.activeProfileId = profileId;
    try {
      this._db.run(
        "UPDATE browser_profiles SET last_used_at = ? WHERE id = ?",
        [new Date().toISOString(), profileId],
      );
    } catch (err) {
      console.warn(`[ProfileManager] markActive failed:`, err);
    }
  }

  releaseActive() {
    this.activeProfileId = null;
  }

  cleanupStale(browserIsRunning: boolean): string[] {
    const now = Date.now();
    if (now - this._lastCleanupRun < this.cleanupIntervalMs) return [];
    this._lastCleanupRun = now;
    if (browserIsRunning) return [];

    const cutoffMs = now - this.ttlDays * 86400 * 1000;
    const removed: string[] = [];
    try {
      const rows = this._db.all<BrowserProfileEntry>(
        "SELECT * FROM browser_profiles WHERE id != ? AND last_used_at < ?",
        [this.activeProfileId ?? "", new Date(cutoffMs).toISOString()],
      );
      for (const row of rows) {
        this._removeEntry(row.id, row.path);
        removed.push(row.id);
      }
    } catch (err) {
      console.warn(`[ProfileManager] cleanupStale failed:`, err);
    }
    return removed;
  }

  private _removeEntry(id: string, p: string) {
    try {
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[ProfileManager] _removeEntry fs failed:`, err);
    }
    try {
      this._db.run("DELETE FROM browser_profiles WHERE id = ?", [id]);
    } catch (err) {
      console.warn(`[ProfileManager] _removeEntry db failed:`, err);
    }
  }

  private _updateSize(id: string, profilePath: string) {
    try {
      const bytes = this._dirSize(profilePath);
      this._db.run("UPDATE browser_profiles SET size_bytes = ? WHERE id = ?", [
        bytes,
        id,
      ]);
    } catch (err) {
      console.warn(`[ProfileManager] _updateSize failed:`, err);
    }
  }

  private _dirSize(dir: string): number {
    let total = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        total += e.isDirectory() ? this._dirSize(full) : fs.statSync(full).size;
      }
    } catch (err) {
      console.warn(`[ProfileManager] _dirSize failed for ${dir}:`, err);
    }
    return total;
  }
}
