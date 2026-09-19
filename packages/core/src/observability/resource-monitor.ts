import * as fs from "node:fs";
import { globalMetricsCollector } from "../metrics-collector.js";

export type ResourceAlertSeverity = "warning" | "critical";

export interface ResourceSnapshot {
  timestamp: string;
  uptimeSeconds: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  openFileDescriptors: number | null;
  activeResources: number | null;
}

export interface ResourceAlert {
  code: "rss_threshold" | "fd_threshold" | "rss_growth";
  severity: ResourceAlertSeverity;
  message: string;
  snapshot: ResourceSnapshot;
  threshold: number;
  dedupeKey: string;
}

export interface ResourceMonitorOptions {
  intervalMs?: number;
  rssWarningBytes?: number;
  rssCriticalBytes?: number;
  fdWarning?: number;
  fdCritical?: number;
  rssGrowthWarningBytes?: number;
  onAlert?: (alert: ResourceAlert) => void | Promise<void>;
  now?: () => number;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function countOpenFileDescriptors(): number | null {
  if (process.platform === "win32") return null;
  try {
    return fs.readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

export function countActiveResources(): number | null {
  try {
    const resources = process.getActiveResourcesInfo?.();
    return resources ? resources.length : null;
  } catch {
    return null;
  }
}

export function getResourceSnapshot(): ResourceSnapshot {
  const memory = process.memoryUsage();
  const snapshot: ResourceSnapshot = {
    timestamp: new Date().toISOString(),
    uptimeSeconds: process.uptime(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    openFileDescriptors: countOpenFileDescriptors(),
    activeResources: countActiveResources(),
  };
  globalMetricsCollector.setGauge("process_rss_bytes", snapshot.rssBytes);
  globalMetricsCollector.setGauge(
    "process_heap_used_bytes",
    snapshot.heapUsedBytes,
  );
  globalMetricsCollector.setGauge(
    "process_heap_total_bytes",
    snapshot.heapTotalBytes,
  );
  globalMetricsCollector.setGauge(
    "process_external_bytes",
    snapshot.externalBytes,
  );
  if (snapshot.openFileDescriptors !== null) {
    globalMetricsCollector.setGauge(
      "process_open_file_descriptors",
      snapshot.openFileDescriptors,
    );
  }
  if (snapshot.activeResources !== null) {
    globalMetricsCollector.setGauge(
      "process_active_resources",
      snapshot.activeResources,
    );
  }
  return snapshot;
}

export class ResourceMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private baselineRss: number | null = null;
  private lastState = new Map<string, ResourceAlertSeverity>();
  private readonly intervalMs: number;
  private readonly rssWarningBytes: number;
  private readonly rssCriticalBytes: number;
  private readonly fdWarning: number;
  private readonly fdCritical: number;
  private readonly rssGrowthWarningBytes: number;
  private readonly onAlert: (alert: ResourceAlert) => void | Promise<void>;
  private readonly now: () => number;

  constructor(options: ResourceMonitorOptions = {}) {
    this.intervalMs = Math.max(
      1000,
      options.intervalMs ??
        positiveNumber(process.env.MIKI_RESOURCE_SAMPLE_MS, 30000),
    );
    this.rssWarningBytes =
      options.rssWarningBytes ??
      positiveNumber(process.env.MIKI_RSS_WARNING_MB, 512) * 1024 * 1024;
    this.rssCriticalBytes =
      options.rssCriticalBytes ??
      positiveNumber(process.env.MIKI_RSS_CRITICAL_MB, 1024) * 1024 * 1024;
    this.fdWarning =
      options.fdWarning ?? positiveNumber(process.env.MIKI_FD_WARNING, 1024);
    this.fdCritical =
      options.fdCritical ?? positiveNumber(process.env.MIKI_FD_CRITICAL, 4096);
    this.rssGrowthWarningBytes =
      options.rssGrowthWarningBytes ??
      positiveNumber(process.env.MIKI_RSS_GROWTH_WARNING_MB, 256) * 1024 * 1024;
    this.onAlert = options.onAlert || (() => undefined);
    this.now = options.now || Date.now;
  }

  sample(snapshot = getResourceSnapshot()): ResourceSnapshot {
    if (this.baselineRss === null) this.baselineRss = snapshot.rssBytes;
    this.evaluateRss(snapshot);
    this.evaluateFds(snapshot);
    this.evaluateGrowth(snapshot);
    return snapshot;
  }

  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => {
      try {
        this.sample();
      } catch (error) {
        console.warn(
          `[observability] resource sample failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  resetBaseline(snapshot = getResourceSnapshot()): void {
    this.baselineRss = snapshot.rssBytes;
    this.lastState.clear();
  }

  private evaluateRss(snapshot: ResourceSnapshot): void {
    if (snapshot.rssBytes >= this.rssCriticalBytes) {
      this.raise({
        code: "rss_threshold",
        severity: "critical",
        message: "Process RSS exceeded the critical threshold.",
        snapshot,
        threshold: this.rssCriticalBytes,
        dedupeKey: "rss_threshold",
      });
    } else if (snapshot.rssBytes >= this.rssWarningBytes) {
      this.raise({
        code: "rss_threshold",
        severity: "warning",
        message: "Process RSS exceeded the warning threshold.",
        snapshot,
        threshold: this.rssWarningBytes,
        dedupeKey: "rss_threshold",
      });
    } else {
      this.resolve("rss_threshold", snapshot);
    }
  }

  private evaluateFds(snapshot: ResourceSnapshot): void {
    if (snapshot.openFileDescriptors === null) return;
    if (snapshot.openFileDescriptors >= this.fdCritical) {
      this.raise({
        code: "fd_threshold",
        severity: "critical",
        message: "Open file descriptors exceeded the critical threshold.",
        snapshot,
        threshold: this.fdCritical,
        dedupeKey: "fd_threshold",
      });
    } else if (snapshot.openFileDescriptors >= this.fdWarning) {
      this.raise({
        code: "fd_threshold",
        severity: "warning",
        message: "Open file descriptors exceeded the warning threshold.",
        snapshot,
        threshold: this.fdWarning,
        dedupeKey: "fd_threshold",
      });
    } else {
      this.resolve("fd_threshold", snapshot);
    }
  }

  private evaluateGrowth(snapshot: ResourceSnapshot): void {
    if (
      this.baselineRss !== null &&
      snapshot.rssBytes - this.baselineRss >= this.rssGrowthWarningBytes
    ) {
      this.raise({
        code: "rss_growth",
        severity: "warning",
        message: "Process RSS grew beyond the configured soak baseline.",
        snapshot,
        threshold: this.rssGrowthWarningBytes,
        dedupeKey: "rss_growth",
      });
    } else {
      this.resolve("rss_growth", snapshot);
    }
  }

  private raise(alert: ResourceAlert): void {
    const previous = this.lastState.get(alert.dedupeKey);
    if (previous === alert.severity) return;
    this.lastState.set(alert.dedupeKey, alert.severity);
    void Promise.resolve(this.onAlert(alert)).catch((error) => {
      console.warn(
        `[observability] alert handler failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
  }

  private resolve(dedupeKey: string, snapshot: ResourceSnapshot): void {
    if (!this.lastState.has(dedupeKey)) return;
    this.lastState.delete(dedupeKey);
    void Promise.resolve(
      this.onAlert({
        code: dedupeKey as ResourceAlert["code"],
        severity: "warning",
        message: "Resource threshold returned to normal.",
        snapshot,
        threshold: 0,
        dedupeKey: `${dedupeKey}:resolved`,
      }),
    ).catch(() => undefined);
  }
}

export function createResourceMonitor(
  options: ResourceMonitorOptions = {},
): ResourceMonitor {
  return new ResourceMonitor(options);
}
