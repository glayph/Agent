import * as os from "os";
import { CostCalibrator } from "./cost-calibrator.js";
import { ShellExecutor } from "./tools/executor.js";
import { ConcurrentTaskManager } from "./concurrent-manager.js";
import { getErrorMessage } from "./errors.js";
import { type RuntimePaths } from "./paths.js";

interface ActivePlanSummary {
  title?: string;
}

export interface IOrchestrator {
  runtimePaths: RuntimePaths;
  modelName: string;
  concurrentManager: ConcurrentTaskManager;
  /**
   * Optional reference to the SQLite database for periodic maintenance.
   * Must expose a `prepare(sql).run()` / `exec(sql)` interface (better-sqlite3).
   */
  db?: {
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown };
    exec?: (sql: string) => void;
  };
  tools?: {
    profileManager?: { cleanupStale: (running: boolean) => void };
    browser?: { browser: unknown | null };
    getToolDefinitions: () => unknown[];
  };
  taskQueue?: {
    cleanup: (ms: number) => number;
  };
  selfImprovement: {
    _reflectionDue: () => boolean;
    _tuningDue: () => boolean;
    _optimizationDue: () => boolean;
    runReflectionCycle: () => Promise<unknown>;
    runPromptTuningCycle: () => Promise<unknown>;
    runOptimizationCycle: () => Promise<unknown>;
    _circuitBreaker?: { tripped: boolean };
    getAccumulatedTunings: () => string[];
  };
  skillGovernance: {
    selfPlanner: { getActivePlan: () => ActivePlanSummary | null };
  };
  _callLlmApi: (
    messages: Array<{ role: string; content: string }>,
    toolsSchema?: unknown[],
  ) => Promise<{
    choices?: Array<{
      message: {
        content?: string;
        tool_calls?: Array<{
          id: string;
          function: { name?: string; arguments?: string };
        }>;
      };
    }>;
  }>;
  _executeToolAndYield: (
    sessionId: string,
    tc: { id?: string; function?: { name?: string; arguments?: string } },
    messages: Array<{ role: string; content: string }>,
  ) => AsyncGenerator<string, void, unknown>;
}

export class HeartbeatEngine {
  private orchestrator: IOrchestrator;
  private interval: number;
  private config: Record<string, unknown>;
  private _running = false;
  private _task: Promise<void> | null = null;
  private _cycle = 0;
  private _lastUserInteraction: number;
  private _nominalBudget: number;
  private _tokenBudget: number;
  private _recoveryCount = 0;
  private _abortController: AbortController | null = null;
  private _shellExecutor: ShellExecutor | null = null;
  /** Tracks which cycle the last SQLite maintenance tasks ran. */
  private _lastCheckpointCycle = 0;
  private _lastIntegrityCycle = 0;
  private _lastVacuumCycle = 0;
  private _lastBackupCycle = 0;

  constructor(
    orchestrator: IOrchestrator,
    interval = 300,
    config: Record<string, unknown> = {},
  ) {
    this.orchestrator = orchestrator;
    this.interval = interval;
    this.config = config;
    this._lastUserInteraction = Date.now() / 1000;
    const resourceLimits = config.resource_limits as
      { max_tokens_per_cycle?: number } | undefined;
    this._nominalBudget = resourceLimits?.max_tokens_per_cycle ?? 1000;
    this._nominalBudget = Math.max(this._nominalBudget, 1);
    this._tokenBudget = this._nominalBudget; // will be recalibrated each pulse
  }

  markUserInteraction(): void {
    this._lastUserInteraction = Date.now() / 1000;
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this._abortController = new AbortController();
    this._task = this._loop();
    console.log(`Heartbeat started (interval=${this.interval * 1000}ms)`);
  }

  async stop(): Promise<void> {
    this._running = false;
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    if (this._task) {
      try {
        await this._task;
      } catch (err) {
        console.warn(`[Heartbeat] task await error:`, err);
      }
    }
    console.log("Heartbeat stopped");
  }

  private async _loop(): Promise<void> {
    while (this._running) {
      try {
        await this._pulse();
        this._recoveryCount = 0;
        const adaptiveInterval = this._getAdaptiveInterval();
        await this._sleep(adaptiveInterval, this._abortController?.signal);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") break;
        console.error(`Heartbeat pulse error: ${getErrorMessage(err)}`);
        await this._recover();
      }
    }
  }

  private async _pulse(): Promise<void> {
    this._cycle++;
    const activeModel = this.orchestrator.modelName || "";
    this._tokenBudget = CostCalibrator.effectiveBudget(
      this._nominalBudget,
      activeModel,
    );
    let disk: Record<string, unknown> | string;
    try {
      disk = await this._assessSystemState();
    } catch (e: unknown) {
      disk = `error: ${getErrorMessage(e)}`;
    }

    const idleMins = (Date.now() / 1000 - this._lastUserInteraction) / 60;
    if (idleMins > 5) {
      const si = this.orchestrator.selfImprovement;
      try {
        if (si._reflectionDue()) await si.runReflectionCycle();
        if (si._tuningDue()) await si.runPromptTuningCycle();
        if (si._optimizationDue()) await si.runOptimizationCycle();
      } catch (e: unknown) {
        console.warn(`Self-improvement cycle: ${getErrorMessage(e)}`);
      }
      try {
        const cb = si._circuitBreaker;
        if (cb?.tripped && idleMins > 30) {
          cb.tripped = false;
        }
      } catch (e: unknown) {
        console.warn(`Circuit breaker check: ${getErrorMessage(e)}`);
      }
    }

    // ── Chrome profile TTL cleanup ──────────────────────────────────────
    try {
      const pm = this.orchestrator.tools?.profileManager;
      if (pm) {
        const browserRunning = !!this.orchestrator.tools?.browser?.browser;
        pm.cleanupStale(browserRunning);
      }
    } catch (err) {
      console.warn(`[Heartbeat] profile cleanup failed:`, err);
    }
    // ── Task cleanup ─────────────────────────────────────────────────────
    try {
      const removed = this.orchestrator.taskQueue?.cleanup?.(3_600_000) ?? 0;
      if (removed > 0) {
        console.log(`[Heartbeat] Cleaned up ${removed} old tasks`);
      }
    } catch (err) {
      console.warn(`[Heartbeat] task cleanup failed:`, err);
    }
    // Suggest dynamic concurrency based on free memory percentage and CPU count
    const suggestedConcurrency = this._suggestMaxConcurrent(disk);
    // Apply if significantly different from current to avoid thrashing
    const currentMax = this.orchestrator.concurrentManager.maxConcurrent;
    if (Math.abs(suggestedConcurrency - currentMax) >= 1) {
      this.orchestrator.concurrentManager.setMaxConcurrent(
        suggestedConcurrency,
      );
    }

    // ── SQLite maintenance ──────────────────────────────────────────────────
    await this._sqliteMaintenance(idleMins);

    // ── Auto Backup (~every 6 hours / 720 cycles) ─────────────────────────
    await this._autoBackup();
  }

  private async _assessSystemState(): Promise<Record<string, unknown>> {
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    return {
      free_mem_gb: Math.round((freeMem / 2 ** 30) * 100) / 100,
      total_mem_gb: Math.round((totalMem / 2 ** 30) * 100) / 100,
      free_mem_pct: Math.round((freeMem / totalMem) * 1000) / 10,
      cpus: os.cpus().length,
      platform: os.platform(),
      hostname: os.hostname(),
    };
  }

  // ── SQLite Maintenance ─────────────────────────────────────────────────────
  //
  // Runs periodically to keep the SQLite WAL file trimmed and detect corruption
  // early. All operations are best-effort; failures are logged but do not crash
  // the heartbeat.
  //
  // Schedule (at 30s interval, one cycle = 30s):
  //   WAL checkpoint : every 120 cycles ≈ 1 hour
  //   integrity_check: every 2880 cycles ≈ once/day
  //   VACUUM         : every 2880 cycles when idle > 30 min

  private async _sqliteMaintenance(idleMins: number): Promise<void> {
    const db = this.orchestrator.db;
    if (!db) return;

    const CHECKPOINT_INTERVAL = 120;   // cycles
    const DAILY_INTERVAL      = 2880;  // cycles

    // WAL checkpoint (~1h)
    if (this._cycle - this._lastCheckpointCycle >= CHECKPOINT_INTERVAL) {
      this._lastCheckpointCycle = this._cycle;
      try {
        db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();
        console.log("[Heartbeat] SQLite WAL checkpoint complete.");
      } catch (e) {
        console.warn("[Heartbeat] WAL checkpoint failed:", getErrorMessage(e));
      }
    }

    // Integrity check (~daily)
    if (this._cycle - this._lastIntegrityCycle >= DAILY_INTERVAL) {
      this._lastIntegrityCycle = this._cycle;
      try {
        const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
        const status = result?.integrity_check ?? "unknown";
        if (status === "ok") {
          console.log("[Heartbeat] SQLite integrity check: ok");
        } else {
          console.error(`[Heartbeat] SQLite integrity check FAILED: ${status}`);
        }
      } catch (e) {
        console.warn("[Heartbeat] Integrity check failed:", getErrorMessage(e));
      }
    }

    // VACUUM (~daily, only when idle > 30 min to avoid disrupting active work)
    if (
      idleMins > 30 &&
      this._cycle - this._lastVacuumCycle >= DAILY_INTERVAL
    ) {
      this._lastVacuumCycle = this._cycle;
      try {
        db.prepare("VACUUM").run();
        console.log("[Heartbeat] SQLite VACUUM complete.");
      } catch (e) {
        console.warn("[Heartbeat] VACUUM failed:", getErrorMessage(e));
      }
    }
  }

  // ── Auto Backup ────────────────────────────────────────────────────────────
  // Creates a scheduled backup every ~6 hours (720 cycles of 30s)
  private async _autoBackup(): Promise<void> {
    const AUTO_BACKUP_INTERVAL = 720; // 720 cycles * 30s = 6 hours
    if (this._cycle - this._lastBackupCycle < AUTO_BACKUP_INTERVAL) return;
    this._lastBackupCycle = this._cycle;

    try {
      const { createBackupManager } = await import("./safety/backup.js");
      const bm = createBackupManager(this.orchestrator.runtimePaths);
      bm.createBackup("scheduled-6h", { includeOperationalData: false });
      console.log("[Heartbeat] Automated 6-hour backup created successfully.");
    } catch (e) {
      console.warn("[Heartbeat] Auto-backup failed:", getErrorMessage(e));
    }
  }

  /**
   * Suggest a max concurrent task count based on system resources.
   * Uses free memory percentage and CPU count to scale from a base of 2.
   * Clamps between 1 and 10.
   */
  private _suggestMaxConcurrent(disk: unknown): number {
    try {
      // disk is from _assessSystemState; it contains free_mem_pct and cpus
      if (typeof disk === "object" && disk !== null) {
        const state = disk as Record<string, unknown>;
        const freeMemPct = Number(state["free_mem_pct"]) || 0; // percentage
        const cpus = Number(state["cpus"]) || 1;
        // Base concurrency on 2, scale by free memory (0-1) and CPUs
        // We want to use more cores when memory is plentiful, but not exceed reasonable limits
        const base = 2;
        const memFactor = freeMemPct / 100; // 0 to 1
        let suggested = base + Math.floor(cpus * memFactor);
        // Clamp to reasonable range
        suggested = Math.max(1, Math.min(10, suggested));
        return suggested;
      }
    } catch (err) {
      console.warn(`[Heartbeat] _suggestMaxConcurrent error:`, err);
    }
    return 3;
  }

  private _getAdaptiveInterval(): number {
    return this.interval * 1000;
  }

  private async _recover(): Promise<void> {
    this._recoveryCount++;
    const backoff = Math.min(60, Math.pow(2, this._recoveryCount)) * 1000;
    await this._sleep(backoff);
  }

  private _sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      let onAbort: (() => void) | null = null;
      const timer = setTimeout(() => {
        if (onAbort && signal) {
          signal.removeEventListener("abort", onAbort);
        }
        resolve();
      }, ms);
      if (signal) {
        onAbort = () => {
          clearTimeout(timer);
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}
