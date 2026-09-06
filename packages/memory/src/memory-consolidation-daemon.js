'use strict';

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
    console.log('[ConsolidationDaemon] Stopped');
  }

  async _runGraphMaintenance() {
    if (!this.graphMemory) return { dormantProjects: 0 };
    const report = this.graphMemory.maintenance(this.options);
    if (report.dormantProjects > 0) console.log('[ConsolidationDaemon] Graph maintenance report:', report);
    return report;
  }

  async _runConsolidation() {
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
        .prepare('SELECT id FROM hourly_chunks WHERE hour_key = ?')
        .get(hourKey);
      if (existing) continue;

      const id = this.tkg._uuid();
      const ts = this.tkg._now();
      this.tkg.db
        .prepare(
          `INSERT INTO hourly_chunks (id, hour_key, hour_start, hour_end, status, event_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'EMPTY', 0, ?, ?)`,
        )
        .run(
          id,
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
