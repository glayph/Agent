import { isInQuietHours } from "./quiet-hours.js";
import type { HeartbeatRunner } from "./runner.js";
import type { HeartbeatCycleResult, HeartbeatSchedulerStatus } from "./types.js";

/**
 * Interval scheduler for HeartbeatRunner.
 * Uses a setTimeout chain (not setInterval) so:
 * - overlapping ticks never stack
 * - intervalSeconds config changes apply on the next cycle
 */
export class HeartbeatScheduler {
  private readonly runner: HeartbeatRunner;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastCycleAt?: string;
  private nextCycleAt?: string;
  private lastResult?: HeartbeatCycleResult;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(
    runner: HeartbeatRunner,
    options?: { log?: (msg: string, meta?: Record<string, unknown>) => void },
  ) {
    this.runner = runner;
    this.log = options?.log ?? ((msg) => console.log(msg));
  }

  start(): void {
    if (this.running) return;
    const cfg = this.runner.getConfig();
    if (!cfg.enabled) {
      this.log("[heartbeat-scheduler] not starting: disabled");
      return;
    }
    this.running = true;
    this.log(
      `[heartbeat-scheduler] started interval=${cfg.intervalSeconds}s`,
    );
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.nextCycleAt = undefined;
    this.log("[heartbeat-scheduler] stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  status(): HeartbeatSchedulerStatus {
    const cfg = this.runner.getConfig();
    return {
      running: this.running,
      enabled: cfg.enabled,
      intervalSeconds: cfg.intervalSeconds,
      lastCycleAt: this.lastCycleAt,
      nextCycleAt: this.nextCycleAt,
      lastResult: this.lastResult ?? this.runner.getLastResult(),
      inQuietHours: isInQuietHours(cfg.quietHours ?? null),
    };
  }

  /** Fire one cycle immediately (does not reset the schedule unless running). */
  async tick(): Promise<HeartbeatCycleResult> {
    const cfg = this.runner.getConfig();
    if (!cfg.enabled) {
      this.log("[heartbeat-scheduler] tick skipped: disabled");
      return (
        this.runner.getLastResult() ?? {
          cycleId: "skipped",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          dryRun: false,
          suppressed: true,
          suppressReason: "disabled",
          items: [],
          report: "disabled",
        }
      );
    }

    this.log("[heartbeat-scheduler] tick");
    const result = await this.runner.runNow(false);
    this.lastCycleAt = result.finishedAt;
    this.lastResult = result;
    this.log(
      `[heartbeat-scheduler] cycle done suppressed=${result.suppressed} items=${result.items.length}`,
    );
    return result;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const cfg = this.runner.getConfig();
    if (!cfg.enabled) {
      this.stop();
      return;
    }
    const ms = Math.max(1, cfg.intervalSeconds) * 1000;
    this.nextCycleAt = new Date(Date.now() + ms).toISOString();
    this.timer = setTimeout(() => {
      void this.onTimer();
    }, ms);
  }

  private async onTimer(): Promise<void> {
    this.timer = null;
    if (!this.running) return;
    try {
      await this.tick();
    } catch (err) {
      this.log(
        `[heartbeat-scheduler] tick error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Re-arm after completion so a long cycle cannot overlap the next
    this.scheduleNext();
  }
}
