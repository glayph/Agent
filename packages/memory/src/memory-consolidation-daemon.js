'use strict';

class MemoryConsolidationDaemon {
  constructor(tkg, options = {}) {
    this.tkg = tkg;
    this.options = {
      checkIntervalMs: 60 * 60 * 1000,
      consolidationIntervalMs: 24 * 60 * 60 * 1000,
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

    this._runConsolidation().catch(() => {});

    console.log(`[ConsolidationDaemon] Started (consolidate: ${this.options.consolidationIntervalMs}ms)`);
  }

  stop() {
    for (const timer of this._timers) {
      clearInterval(timer);
    }
    this._timers = [];
    this._running = false;
    console.log('[ConsolidationDaemon] Stopped');
  }

  async _runConsolidation() {
    const report = this.tkg.runConsolidation();
    if (report.hoursConsolidated > 0 || report.daysSummarized > 0) {
      console.log(`[ConsolidationDaemon] Consolidation report:`, report);
    }
    return report;
  }

  async runOnce() {
    const consolidateResult = await this._runConsolidation();
    return { consolidation: consolidateResult };
  }

  _getHourKey(date) {
    return this.tkg._getHourKey(date);
  }
}

module.exports = MemoryConsolidationDaemon;
