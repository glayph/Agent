'use strict';

/**
 * Fix #9: SQLite advisory lease for cross-process maintenance leader election.
 *
 * Each daemon instance tries to acquire an exclusive lease row in the
 * maintenance_lease table. The lease lasts LEASE_TTL_MS; if the holder
 * crashes, a competing process can take over after the TTL expires.
 * Only the lease-holder runs consolidation/maintenance; all others skip
 * silently. This prevents duplicate consolidation, index corruption from
 * concurrent READ-then-WRITE loops, and ordering races.
 */
const LEASE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LEASE_OWNER_ID = `pid:${process.pid}:${Date.now()}`;

function ensureLeaseTable(db) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS maintenance_lease (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      owner TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  } catch { /* table may already exist */ }
}

function tryAcquireLease(db) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
  const nowIso = now.toISOString();
  try {
    // Insert or replace only when: no row exists, OR current row is expired,
    // OR we already own it (renewal).
    const result = db.prepare(`
      INSERT INTO maintenance_lease (id, owner, expires_at, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner = excluded.owner,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
      WHERE expires_at < ? OR owner = ?
    `).run(LEASE_OWNER_ID, expiresAt, nowIso, nowIso, LEASE_OWNER_ID);
    return result.changes > 0;
  } catch { return false; }
}

function releaseLease(db) {
  try {
    db.prepare(`DELETE FROM maintenance_lease WHERE id = 1 AND owner = ?`).run(LEASE_OWNER_ID);
  } catch { /* non-fatal */ }
}

class MemoryConsolidationDaemon {
  constructor(tkg, options = {}) {
    this.tkg = tkg;
    this.graphMemory = options.graphMemory || tkg?.graphMemory || null;
    this.options = {
      checkIntervalMs: 60 * 60 * 1000,
      consolidationIntervalMs: 24 * 60 * 60 * 1000,
      fillEmptyChunksIntervalMs: 60 * 60 * 1000,
      maxEmptyChunkLookbackHours: 24,
      ...options
    };
    this._timers = [];
    this._running = false;
    // Acquire lease table in the TKG database for cross-process coordination.
    this._db = tkg?.db || null;
    if (this._db) { try { ensureLeaseTable(this._db); } catch { this._db = null; } }
  }

  /** Returns true when this process holds the maintenance lease. */
  _isLeader() {
    if (!this._db) return true; // no DB access: assume solo (safe degradation)
    return tryAcquireLease(this._db);
  }

  start() {
    if (this._running) return;
    this._running = true;

    this._timers.push(setInterval(() => {
      this._runConsolidation().catch(err => {
        console.error('[ConsolidationDaemon] Consolidation error:', err.message);
      });
    }, this.options.consolidationIntervalMs));

    this._timers.push(setInterval(() => {
      try {
        this._fillEmptyChunks();
      } catch (err) {
        console.error('[ConsolidationDaemon] fillEmptyChunks error:', err.message);
      }
    }, this.options.fillEmptyChunksIntervalMs));

    this._timers.push(setInterval(() => {
      this._runGraphMaintenance().catch(err => {
        console.error('[ConsolidationDaemon] graph maintenance error:', err.message);
      });
    }, this.options.consolidationIntervalMs));

    this._runConsolidation().catch(() => {});
    this._runGraphMaintenance().catch(err => {
      console.error('[ConsolidationDaemon] graph maintenance error:', err.message);
    });
    try {
      this._fillEmptyChunks();
    } catch (err) {
      console.error('[ConsolidationDaemon] fillEmptyChunks error:', err.message);
    }

    console.log(`[ConsolidationDaemon] Started (consolidate: ${this.options.consolidationIntervalMs}ms, fillEmptyChunks: ${this.options.fillEmptyChunksIntervalMs}ms)`);
  }

  stop() {
    for (const timer of this._timers) {
      clearInterval(timer);
    }
    this._timers = [];
    this._running = false;
    // Fix #9: release the advisory lease so another process can take over.
    if (this._db) { try { releaseLease(this._db); } catch { /* ignore */ } }
    console.log('[ConsolidationDaemon] Stopped');
  }

  async _runGraphMaintenance() {
    // Fix #9: only the lease-holder runs maintenance.
    if (!this.graphMemory) return { dormantProjects: 0 };
    if (!this._isLeader()) return { dormantProjects: 0, skipped: 'not_leader' };
    const report = this.graphMemory.maintenance(this.options);
    // Fix #8: selective store retention/dedup runs in the same leader-guarded pass.
    try {
      const sel = this.tkg?.selectiveMemory?.maintenance?.(this.options);
      if (sel) report.selective = sel;
    } catch (err) {
      console.error('[ConsolidationDaemon] selective maintenance error:', err.message);
    }
    if (report.dormantProjects > 0) console.log('[ConsolidationDaemon] Graph maintenance report:', report);
    return report;
  }

  async _runConsolidation() {
    // Fix #9: only the lease-holder runs consolidation.
    if (!this._isLeader()) return { hoursConsolidated: 0, daysSummarized: 0, skipped: 'not_leader' };
    const report = this.tkg.runConsolidation();
    if (report.hoursConsolidated > 0 || report.daysSummarized > 0) {
      console.log(`[ConsolidationDaemon] Consolidation report:`, report);
    }
    return report;
  }

  /**
   * Backfill a placeholder ('EMPTY') hourly_chunks row for every hour in
   * the last `maxEmptyChunkLookbackHours` hours that has no chunk at all
   * (an hour only gets a real chunk on its first event - see
   * TemporalKnowledgeGraph.writeEvent/getOrCreateCurrentChunk). Without
   * this, getHoursInRange()/timeline queries have silent gaps for hours
   * where nothing happened, indistinguishable from hours that just
   * haven't been queried yet.
   *
   * EMPTY chunks are inert everywhere else that matters: getContextWindow
   * already special-cases `status !== 'EMPTY'` before using the current
   * chunk, and runConsolidation's eligibility query filters on
   * `status = 'ACTIVE'`, so a backfilled EMPTY chunk is never summarized
   * as if it contained real events.
   *
   * Returns the number of chunks created, so callers (runOnce) can report
   * it.
   */
  _fillEmptyChunks() {
    const lookbackHours = this.options.maxEmptyChunkLookbackHours;
    const now = new Date();
    let created = 0;

    for (let i = 0; i < lookbackHours; i++) {
      const hourDate = new Date(now.getTime() - i * 60 * 60 * 1000);
      const hourKey = this.tkg._getHourKey(hourDate);
      const existing = this.tkg.db
        .prepare('SELECT id FROM hourly_chunks WHERE hour_key = ? AND scope_key = ?')
        .get(hourKey, this.tkg.defaultScope.scopeKey);
      if (existing) continue;

      const id = this.tkg._uuid();
      const ts = this.tkg._now();
      this.tkg.db
        .prepare(
          `INSERT INTO hourly_chunks (id, scope_key, agent_id, owner_id, workspace_id, hour_key, hour_start, hour_end, status, event_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EMPTY', 0, ?, ?)`,
        )
        .run(
          id,
          this.tkg.defaultScope.scopeKey,
          this.tkg.defaultScope.agentId,
          this.tkg.defaultScope.ownerId,
          this.tkg.defaultScope.workspaceId,
          hourKey,
          this.tkg._getHourStart(hourKey),
          this.tkg._getHourEnd(hourKey),
          ts,
          ts,
        );
      created++;
    }

    if (created > 0) {
      console.log(`[ConsolidationDaemon] Backfilled ${created} empty hourly chunk(s)`);
    }
    return created;
  }

  async runOnce() {
    const consolidateResult = await this._runConsolidation();
    const graphMaintenance = await this._runGraphMaintenance();
    const emptyChunksFilled = this._fillEmptyChunks();
    return { consolidation: consolidateResult, graphMaintenance, emptyChunksFilled };
  }

  _getHourKey(date) {
    return this.tkg._getHourKey(date);
  }
}

module.exports = MemoryConsolidationDaemon;
