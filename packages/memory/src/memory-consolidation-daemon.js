'use strict';

class MemoryConsolidationDaemon {
  constructor(tkg, options = {}) {
    this.tkg = tkg;
    this.options = {
      checkIntervalMs: 60 * 60 * 1000,
      fillEmptyChunksIntervalMs: 30 * 60 * 1000,
      consolidationIntervalMs: 24 * 60 * 60 * 1000,
      maxEmptyChunkLookbackHours: 72,
      ...options
    };
    this._timers = [];
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;

    this._timers.push(setInterval(() => {
      this._fillEmptyChunks().catch(err => {
        console.error('[ConsolidationDaemon] Empty chunk fill error:', err.message);
      });
    }, this.options.fillEmptyChunksIntervalMs));

    this._timers.push(setInterval(() => {
      this._runConsolidation().catch(err => {
        console.error('[ConsolidationDaemon] Consolidation error:', err.message);
      });
    }, this.options.consolidationIntervalMs));

    this._fillEmptyChunks().catch(() => {});
    this._runConsolidation().catch(() => {});

    console.log(`[ConsolidationDaemon] Started (check: ${this.options.checkIntervalMs}ms, fill: ${this.options.fillEmptyChunksIntervalMs}ms, consolidate: ${this.options.consolidationIntervalMs}ms)`);
  }

  stop() {
    for (const timer of this._timers) {
      clearInterval(timer);
    }
    this._timers = [];
    this._running = false;
    console.log('[ConsolidationDaemon] Stopped');
  }

  async _fillEmptyChunks() {
    const now = new Date();
    const lookback = new Date(now.getTime() - this.options.maxEmptyChunkLookbackHours * 60 * 60 * 1000);
    const startKey = this._getHourKey(lookback);
    const endKey = this._getHourKey(now);
    const created = this.tkg.fillMissingEmptyChunks(startKey, endKey);
    if (created.length > 0) {
      console.log(`[ConsolidationDaemon] Filled ${created.length} missing empty chunks from ${startKey} to ${endKey}`);
    }
    return created;
  }

  async _runConsolidation() {
    const report = this.tkg.runConsolidation();
    if (report.hoursConsolidated > 0 || report.daysSummarized > 0) {
      console.log(`[ConsolidationDaemon] Consolidation report:`, report);
    }
    return report;
  }

  async runOnce() {
    const emptyResult = await this._fillEmptyChunks();
    const consolidateResult = await this._runConsolidation();
    return { emptyChunksFilled: emptyResult.length, consolidation: consolidateResult };
  }

  _getHourKey(date) {
    return this.tkg._getHourKey(date);
  }
}

module.exports = MemoryConsolidationDaemon;
