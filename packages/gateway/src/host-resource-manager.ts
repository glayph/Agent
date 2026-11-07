import { cpus, freemem, loadavg, totalmem } from "node:os";
import { readFileSync, statfsSync } from "node:fs";

export interface HostResourceSnapshot {
  cpuCount: number;
  loadPerCpu: number;
  /** False when the platform does not expose a meaningful load average (currently Windows). */
  loadAvailable?: boolean;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  freeMemoryRatio: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  freeDiskRatio?: number;
  sampledAt: string;
}

export interface HostResourceManagerOptions {
  minFreeMemoryRatio?: number;
  highLoadPerCpu?: number;
  criticalLoadPerCpu?: number;
  minFreeDiskRatio?: number;
  diskPath?: string;
  /** Injected for deterministic tests and non-standard hosts. */
  sample?: () => Omit<HostResourceSnapshot, "sampledAt">;
}

/**
 * Converts CPU, RAM, and data-volume pressure into a safe concurrency ceiling.
 * It only controls admission of new jobs; it never kills work already in progress.
 */
export class HostResourceManager {
  private readonly minFreeMemoryRatio: number;
  private readonly highLoadPerCpu: number;
  private readonly criticalLoadPerCpu: number;
  private readonly minFreeDiskRatio: number;
  private readonly sampleHost: () => Omit<HostResourceSnapshot, "sampledAt">;
  private lastSnapshot: HostResourceSnapshot | null = null;
  private lastSampledAt = 0;

  constructor(options: HostResourceManagerOptions = {}) {
    this.minFreeMemoryRatio = clamp(options.minFreeMemoryRatio ?? 0.12, 0.03, 0.5);
    this.highLoadPerCpu = clamp(options.highLoadPerCpu ?? 1.25, 0.5, 8);
    this.criticalLoadPerCpu = Math.max(this.highLoadPerCpu, clamp(options.criticalLoadPerCpu ?? 2, 0.75, 16));
    this.minFreeDiskRatio = clamp(options.minFreeDiskRatio ?? 0.05, 0.01, 0.5);
    this.sampleHost = options.sample ?? (() => {
      const hostTotal = Math.max(1, totalmem());
      const hostFree = Math.max(0, Math.min(hostTotal, freemem()));
      const hostCpuCount = Math.max(1, cpus().length);
      const cgroupMemory = readCgroupMemory();
      const cgroupCpuCount = readCgroupCpuCount();
      const total = cgroupMemory?.limitBytes ?? hostTotal;
      const free = cgroupMemory ? Math.max(0, total - cgroupMemory.usageBytes) : hostFree;
      const count = Math.max(0.1, Math.min(hostCpuCount, cgroupCpuCount ?? hostCpuCount));
      const load = loadavg()[0];
      let diskFreeBytes: number | undefined;
      let diskTotalBytes: number | undefined;
      let freeDiskRatio: number | undefined;
      try {
        const disk = statfsSync(options.diskPath ?? process.cwd());
        diskTotalBytes = Math.max(0, Number(disk.blocks) * Number(disk.bsize));
        diskFreeBytes = Math.max(0, Number(disk.bavail) * Number(disk.bsize));
        if (diskTotalBytes > 0) freeDiskRatio = Math.min(1, diskFreeBytes / diskTotalBytes);
      } catch { /* Disk statistics are platform/permission dependent; CPU and RAM remain available. */ }
      return {
        cpuCount: count,
        // Some platforms (notably Windows) report no load average. Treat it as
        // unknown rather than saturated.
        loadPerCpu: Number.isFinite(load) && load > 0 ? load / count : 0,
        loadAvailable: process.platform !== "win32",
        freeMemoryBytes: free,
        totalMemoryBytes: total,
        freeMemoryRatio: free / total,
        ...(diskFreeBytes !== undefined ? { diskFreeBytes } : {}),
        ...(diskTotalBytes !== undefined ? { diskTotalBytes } : {}),
        ...(freeDiskRatio !== undefined ? { freeDiskRatio } : {}),
      };
    });
  }

  snapshot(): HostResourceSnapshot {
    // The worker polls frequently. One-second sampling avoids synchronous
    // cgroup reads on every queue tick while still reacting quickly to pressure.
    if (this.lastSnapshot && Date.now() - this.lastSampledAt < 1_000) return this.lastSnapshot;
    try {
      const sample = this.sampleHost();
      const total = Math.max(1, sample.totalMemoryBytes);
      const free = Math.max(0, Math.min(total, sample.freeMemoryBytes));
      const snapshot: HostResourceSnapshot = {
        cpuCount: Math.max(1, Math.floor(sample.cpuCount || 1)),
        loadPerCpu: Number.isFinite(sample.loadPerCpu) ? Math.max(0, sample.loadPerCpu) : 0,
        loadAvailable: sample.loadAvailable !== false,
        freeMemoryBytes: free,
        totalMemoryBytes: total,
        freeMemoryRatio: Number.isFinite(sample.freeMemoryRatio) ? clamp(sample.freeMemoryRatio, 0, 1) : free / total,
        ...(Number.isFinite(sample.diskFreeBytes) ? { diskFreeBytes: Math.max(0, Number(sample.diskFreeBytes)) } : {}),
        ...(Number.isFinite(sample.diskTotalBytes) ? { diskTotalBytes: Math.max(0, Number(sample.diskTotalBytes)) } : {}),
        ...(Number.isFinite(sample.freeDiskRatio) ? { freeDiskRatio: clamp(Number(sample.freeDiskRatio), 0, 1) } : {}),
        sampledAt: new Date().toISOString(),
      };
      this.lastSnapshot = snapshot;
      this.lastSampledAt = Date.now();
      return snapshot;
    } catch {
      // A monitoring failure must not make the worker unavailable.
      return this.lastSnapshot ?? {
        // Unknown host capacity is treated conservatively: keep one worker
        // available rather than admitting the full configured parallel load.
        cpuCount: 1, loadPerCpu: 0, loadAvailable: false, freeMemoryBytes: 0, totalMemoryBytes: 1,
        freeMemoryRatio: 0, sampledAt: new Date().toISOString(),
      };
    }
  }

  recommendedConcurrency(configuredMaximum: number): number {
    // The configured ceiling is an operator resource preference, not a hidden
    // hard-coded worker cap. CPU/RAM pressure below it still throttles admission.
    const requested = Math.floor(configuredMaximum);
    const maximum = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
    const current = this.snapshot();
    if (current.freeDiskRatio !== undefined && current.freeDiskRatio < this.minFreeDiskRatio) return 1;
    if (current.freeMemoryRatio < this.minFreeMemoryRatio) return 1;
    if (current.loadPerCpu >= this.criticalLoadPerCpu) return 1;
    if (current.loadPerCpu >= this.highLoadPerCpu || current.freeMemoryRatio < this.minFreeMemoryRatio * 1.5) {
      return Math.max(1, Math.floor(maximum / 2));
    }
    return maximum;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function readCgroupMemory(): { limitBytes: number; usageBytes: number } | null {
  try {
    const limitText = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    const usageText = readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim();
    if (limitText !== "max") {
      const limit = Number(limitText);
      const usage = Number(usageText);
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(usage) && usage >= 0 && limit < totalmem() * 4) {
        return { limitBytes: limit, usageBytes: Math.min(limit, usage) };
      }
    }
  } catch { /* cgroup v2 is not mounted; try v1 below. */ }
  try {
    const limit = Number(readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8").trim());
    const usage = Number(readFileSync("/sys/fs/cgroup/memory/memory.usage_in_bytes", "utf8").trim());
    if (Number.isFinite(limit) && limit > 0 && limit < totalmem() * 4 && Number.isFinite(usage) && usage >= 0) {
      return { limitBytes: limit, usageBytes: Math.min(limit, usage) };
    }
  } catch { /* cgroup v1 is not mounted. */ }
  return null;
}

function readCgroupCpuCount(): number | null {
  try {
    const [quotaText, periodText] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (quotaText !== "max") {
      const quota = Number(quotaText);
      const period = Number(periodText);
      if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) return quota / period;
    }
  } catch { /* cgroup v2 is not mounted; try v1 below. */ }
  try {
    const quota = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8").trim());
    const period = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8").trim());
    if (quota > 0 && period > 0) return quota / period;
  } catch { /* cgroup v1 is not mounted. */ }
  return null;
}
