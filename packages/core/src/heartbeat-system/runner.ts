import { randomUUID } from "node:crypto";
import {
  defaultClassify,
  loadChecklistFile,
  resolveChecklistPath,
  stripTypePrefix,
} from "./checklist.js";
import { isInQuietHours } from "./quiet-hours.js";
import type {
  ChecklistItem,
  HeartbeatConfig,
  HeartbeatCycleResult,
  HeartbeatHooks,
  HeartbeatItemResult,
  HeartbeatResponseType,
} from "./types.js";
import { DEFAULT_HEARTBEAT_CONFIG } from "./types.js";
import type { CommandQueue } from "../command-queue/index.js";

export interface HeartbeatRunnerOptions {
  workspaceRoot: string;
  config?: Partial<HeartbeatConfig>;
  hooks?: HeartbeatHooks;
  /**
   * Optional Step 07 command queue. Cycles are enqueued on the `heartbeat`
   * lane so they never share a session_key with main-lane user work.
   */
  commandQueue?: CommandQueue;
}

function mergeConfig(partial?: Partial<HeartbeatConfig>): HeartbeatConfig {
  const merged = { ...DEFAULT_HEARTBEAT_CONFIG, ...partial };
  // Clamp interval to at least 1 second
  merged.intervalSeconds = Math.max(
    1,
    Number(merged.intervalSeconds) || DEFAULT_HEARTBEAT_CONFIG.intervalSeconds,
  );
  if (merged.maxItemsPerCycle != null && merged.maxItemsPerCycle < 0) {
    merged.maxItemsPerCycle = 0;
  }
  return merged;
}

/**
 * Execute one heartbeat cycle (or dry-run report).
 * Never touches main-lane sessions; uses heartbeat lane when a queue is provided.
 */
export class HeartbeatRunner {
  private readonly workspaceRoot: string;
  private config: HeartbeatConfig;
  private readonly hooks: HeartbeatHooks;
  private readonly commandQueue?: CommandQueue;
  private lastResult?: HeartbeatCycleResult;
  /** Prevent overlapping runNow from scheduler + manual trigger. */
  private inFlight: Promise<HeartbeatCycleResult> | null = null;

  constructor(options: HeartbeatRunnerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.config = mergeConfig(options.config);
    this.hooks = options.hooks ?? {};
    this.commandQueue = options.commandQueue;
  }

  getConfig(): HeartbeatConfig {
    return this.config;
  }

  updateConfig(partial: Partial<HeartbeatConfig>): void {
    this.config = mergeConfig({ ...this.config, ...partial });
  }

  getLastResult(): HeartbeatCycleResult | undefined {
    return this.lastResult;
  }

  /**
   * Run a heartbeat cycle immediately.
   * dryRun=true: parse checklist + classify + report only (no side effects).
   * dryRun bypasses quiet_hours and enabled checks so testing always works.
   */
  async runNow(dryRun = false): Promise<HeartbeatCycleResult> {
    // Serialize concurrent runNow calls (scheduler tick + manual trigger)
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.runNowInner(dryRun).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runNowInner(dryRun: boolean): Promise<HeartbeatCycleResult> {
    const cycleId = randomUUID();
    const startedAt = new Date().toISOString();
    const log = this.hooks.log ?? (() => {});

    // dry_run always allowed (testing); live runs respect enabled + quiet_hours
    if (!dryRun && !this.config.enabled) {
      const result = this.suppressedResult(
        cycleId,
        startedAt,
        dryRun,
        "heartbeat disabled",
      );
      this.lastResult = result;
      log("[heartbeat] suppressed: disabled", { cycleId });
      return result;
    }

    if (!dryRun && isInQuietHours(this.config.quietHours ?? null)) {
      const result = this.suppressedResult(
        cycleId,
        startedAt,
        dryRun,
        "quiet_hours",
      );
      this.lastResult = result;
      log("[heartbeat] suppressed: quiet_hours", { cycleId });
      return result;
    }

    if (
      !dryRun &&
      this.config.skipWhenMainBusy &&
      this.hooks.isMainLaneBusy?.()
    ) {
      const result = this.suppressedResult(
        cycleId,
        startedAt,
        dryRun,
        "main_lane_busy",
      );
      this.lastResult = result;
      log("[heartbeat] suppressed: main_lane_busy", { cycleId });
      return result;
    }

    const filePath = resolveChecklistPath(
      this.config.checklistPath,
      this.workspaceRoot,
    );
    let items = loadChecklistFile(filePath);
    const max = this.config.maxItemsPerCycle ?? 0;
    if (max > 0) items = items.slice(0, max);

    if (this.commandQueue && !dryRun) {
      const session_key = "heartbeat:system:default";
      let cycleResult: HeartbeatCycleResult | undefined;
      await this.commandQueue.enqueue({
        session_key,
        message: `heartbeat-cycle:${cycleId}`,
        lane: "heartbeat",
        mode: "followup",
        surface: "timer",
        execute: async ({ signal }) => {
          if (signal.aborted) return;
          cycleResult = await this.executeItems(
            cycleId,
            startedAt,
            items,
            false,
            signal,
          );
        },
      });
      await this.commandQueue.drain(session_key, 30_000).catch(() => {});
      const result =
        cycleResult ??
        this.suppressedResult(cycleId, startedAt, false, "queue_did_not_run");
      this.lastResult = result;
      log("[heartbeat] cycle complete (queued)", {
        cycleId,
        items: result.items.length,
      });
      return result;
    }

    const result = await this.executeItems(
      cycleId,
      startedAt,
      items,
      dryRun,
      undefined,
    );
    this.lastResult = result;
    log("[heartbeat] cycle complete", {
      cycleId,
      dryRun,
      items: result.items.length,
    });
    return result;
  }

  private async executeItems(
    cycleId: string,
    startedAt: string,
    items: ChecklistItem[],
    dryRun: boolean,
    signal: AbortSignal | undefined,
  ): Promise<HeartbeatCycleResult> {
    const classify = this.hooks.classify ?? defaultClassify;
    const results: HeartbeatItemResult[] = [];

    for (const item of items) {
      if (signal?.aborted) break;
      const responseType = classify(item);
      const text = stripTypePrefix(item.text);
      let summary = text;

      if (!dryRun) {
        summary = await this.applyResponse(responseType, item, text, signal);
      } else {
        summary = `[dry_run] would ${responseType}: ${text}`;
      }

      results.push({ item, responseType, summary, dryRun });
    }

    const finishedAt = new Date().toISOString();
    const report = this.buildReport(
      cycleId,
      startedAt,
      finishedAt,
      dryRun,
      false,
      results,
    );
    return {
      cycleId,
      startedAt,
      finishedAt,
      dryRun,
      suppressed: false,
      items: results,
      report,
    };
  }

  private async applyResponse(
    type: HeartbeatResponseType,
    item: ChecklistItem,
    text: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    try {
      switch (type) {
        case "proactive_notify": {
          await this.hooks.notify?.(text);
          return `notified: ${text}`;
        }
        case "memory_update": {
          await this.hooks.memoryUpdate?.(text);
          return `memory: ${text}`;
        }
        case "silent_tool_run": {
          if (this.hooks.runSilentTools) {
            const r = await this.hooks.runSilentTools(
              item,
              signal ?? AbortSignal.timeout(60_000),
            );
            return r.summary || `tools: ${text}`;
          }
          return `tools(skipped-no-hook): ${text}`;
        }
        case "no_op":
        default:
          return `no_op: ${text}`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `error(${type}): ${msg}`;
    }
  }

  private suppressedResult(
    cycleId: string,
    startedAt: string,
    dryRun: boolean,
    reason: string,
  ): HeartbeatCycleResult {
    const finishedAt = new Date().toISOString();
    return {
      cycleId,
      startedAt,
      finishedAt,
      dryRun,
      suppressed: true,
      suppressReason: reason,
      items: [],
      report: `Heartbeat cycle ${cycleId} suppressed: ${reason}`,
    };
  }

  private buildReport(
    cycleId: string,
    startedAt: string,
    finishedAt: string,
    dryRun: boolean,
    suppressed: boolean,
    items: HeartbeatItemResult[],
  ): string {
    const lines = [
      `Heartbeat cycle ${cycleId}`,
      `started: ${startedAt}`,
      `finished: ${finishedAt}`,
      `dry_run: ${dryRun}`,
      `suppressed: ${suppressed}`,
      `items: ${items.length}`,
      ...items.map(
        (r) => `  L${r.item.line} [${r.responseType}] ${r.summary}`,
      ),
    ];
    return lines.join("\n");
  }
}

/** Convenience: run_heartbeat_now(dry_run=False) */
export async function runHeartbeatNow(
  runner: HeartbeatRunner,
  dryRun = false,
): Promise<HeartbeatCycleResult> {
  return runner.runNow(dryRun);
}
