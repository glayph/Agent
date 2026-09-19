import { describe, expect, test, jest } from "@jest/globals";
import { ResourceMonitor } from "./resource-monitor.js";
import type { ResourceSnapshot } from "./resource-monitor.js";

function snapshot(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    timestamp: "2026-08-26T00:00:00.000Z",
    uptimeSeconds: 10,
    rssBytes: 100,
    heapUsedBytes: 40,
    heapTotalBytes: 80,
    externalBytes: 10,
    arrayBuffersBytes: 0,
    openFileDescriptors: 10,
    activeResources: 2,
    ...overrides,
  };
}

describe("ResourceMonitor", () => {
  test("emits one alert per state and a recovery event", () => {
    const onAlert = jest.fn();
    const monitor = new ResourceMonitor({
      rssWarningBytes: 200,
      rssCriticalBytes: 400,
      fdWarning: 20,
      fdCritical: 40,
      rssGrowthWarningBytes: 1000,
      onAlert,
    });

    monitor.sample(snapshot({ rssBytes: 250 }));
    monitor.sample(snapshot({ rssBytes: 300 }));
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0][0]).toMatchObject({
      code: "rss_threshold",
      severity: "warning",
    });

    monitor.sample(snapshot({ rssBytes: 100 }));
    expect(onAlert).toHaveBeenCalledTimes(2);
    expect(onAlert.mock.calls[1][0]).toMatchObject({
      code: "rss_threshold",
      message: "Resource threshold returned to normal.",
    });
  });

  test("reports critical file descriptor pressure", () => {
    const onAlert = jest.fn();
    const monitor = new ResourceMonitor({
      rssWarningBytes: 10_000,
      rssCriticalBytes: 20_000,
      fdWarning: 20,
      fdCritical: 40,
      rssGrowthWarningBytes: 10_000,
      onAlert,
    });

    monitor.sample(snapshot({ openFileDescriptors: 50 }));
    expect(onAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "fd_threshold",
        severity: "critical",
      }),
    );
  });

  test("can reset the RSS baseline before a new soak window", () => {
    const onAlert = jest.fn();
    const monitor = new ResourceMonitor({
      rssWarningBytes: 10_000,
      rssCriticalBytes: 20_000,
      fdWarning: 10_000,
      fdCritical: 20_000,
      rssGrowthWarningBytes: 100,
      onAlert,
    });

    monitor.sample(snapshot({ rssBytes: 100 }));
    monitor.resetBaseline(snapshot({ rssBytes: 500 }));
    monitor.sample(snapshot({ rssBytes: 550 }));
    expect(onAlert).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: "rss_growth" }),
    );
  });
});
