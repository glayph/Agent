import { describe, expect, it } from "vitest";
import { HostResourceManager } from "./host-resource-manager.js";

describe("HostResourceManager", () => {
  it("uses the configured ceiling when host pressure is low", () => {
    const manager = new HostResourceManager({ sample: () => ({ cpuCount: 8, loadPerCpu: 0.2, freeMemoryBytes: 8, totalMemoryBytes: 10, freeMemoryRatio: 0.8 }) });
    expect(manager.recommendedConcurrency(4)).toBe(4);
  });

  it("reduces admission when memory is pressured", () => {
    const manager = new HostResourceManager({ sample: () => ({ cpuCount: 8, loadPerCpu: 0.1, freeMemoryBytes: 1, totalMemoryBytes: 10, freeMemoryRatio: 0.1 }) });
    expect(manager.recommendedConcurrency(4)).toBe(1);
  });

  it("reduces admission under high CPU load without exceeding one half", () => {
    const manager = new HostResourceManager({ sample: () => ({ cpuCount: 4, loadPerCpu: 1.5, freeMemoryBytes: 8, totalMemoryBytes: 10, freeMemoryRatio: 0.8 }) });
    expect(manager.recommendedConcurrency(4)).toBe(2);
  });

  it("does not interrupt admission below one worker and clamps configured limits", () => {
    const manager = new HostResourceManager({ sample: () => ({ cpuCount: 1, loadPerCpu: 20, freeMemoryBytes: 9, totalMemoryBytes: 10, freeMemoryRatio: 0.9 }) });
    expect(manager.recommendedConcurrency(0)).toBe(1);
  });

  it("does not apply an arbitrary fixed worker ceiling", () => {
    const manager = new HostResourceManager({ sample: () => ({ cpuCount: 64, loadPerCpu: 0.1, freeMemoryBytes: 9, totalMemoryBytes: 10, freeMemoryRatio: 0.9 }) });
    expect(manager.recommendedConcurrency(256)).toBe(256);
  });

  it("reduces admission when the configured data volume is almost full", () => {
    const manager = new HostResourceManager({
      minFreeDiskRatio: 0.05,
      sample: () => ({ cpuCount: 8, loadPerCpu: 0.1, freeMemoryBytes: 9, totalMemoryBytes: 10, freeMemoryRatio: 0.9, diskFreeBytes: 1, diskTotalBytes: 100, freeDiskRatio: 0.01 }),
    });
    expect(manager.recommendedConcurrency(12)).toBe(1);
    expect(manager.snapshot()).toMatchObject({ diskFreeBytes: 1, diskTotalBytes: 100, freeDiskRatio: 0.01 });
  });

  it("falls back conservatively when resource sampling throws", () => {
    const manager = new HostResourceManager({ sample: () => { throw new Error("probe failed"); } });
    expect(manager.recommendedConcurrency(3)).toBe(1);
  });
});


it("preserves unavailable host load telemetry rather than claiming a zero load", () => {
  const manager = new HostResourceManager({ sample: () => ({ cpuCount: 8, loadPerCpu: 0, loadAvailable: false, freeMemoryBytes: 8, totalMemoryBytes: 10, freeMemoryRatio: 0.8 }) })
  expect(manager.snapshot().loadAvailable).toBe(false)
})
