import { SqliteAuditLog } from "../audit-log.js";
import { SafeModeManager, type SafeModeState } from "./safe-mode.js";

export interface WatchdogProbe {
  name: string;
  healthy: boolean;
  message?: string;
  restartable?: boolean;
}

export interface WatchdogServiceStatus {
  name: string;
  healthy: boolean;
  failures: number;
  restartable: boolean;
  lastMessage: string;
  lastCheckedAt: string;
  nextRetryAt?: string;
}

export interface WatchdogStatus {
  enabled: boolean;
  services: WatchdogServiceStatus[];
  safeMode: SafeModeState;
}

export class Watchdog {
  private readonly services = new Map<string, WatchdogServiceStatus>();
  private readonly normalizedFailureThreshold: number;
  private readonly normalizedBaseBackoffMs: number;

  constructor(
    private readonly safeMode: SafeModeManager,
    private readonly audit?: SqliteAuditLog,
    failureThreshold = 3,
    baseBackoffMs = 30_000,
  ) {
    this.normalizedFailureThreshold = Math.max(
      1,
      Math.min(Math.floor(failureThreshold || 3), 100),
    );
    this.normalizedBaseBackoffMs = Math.max(
      1_000,
      Math.min(Math.floor(baseBackoffMs || 30_000), 60 * 60_000),
    );
  }

  recordProbe(probe: WatchdogProbe): WatchdogServiceStatus {
    const serviceName = probe.name.trim();
    if (!serviceName) {
      throw new Error("Watchdog probe name is required.");
    }
    const now = new Date();
    const previous = this.services.get(serviceName);
    const failures = probe.healthy ? 0 : (previous?.failures || 0) + 1;
    const backoffMs = Math.min(
      this.normalizedBaseBackoffMs * Math.max(1, failures),
      24 * 60 * 60_000,
    );
    const lastMessage =
      probe.message?.trim().slice(0, 1000) ||
      (probe.healthy ? "healthy" : "unhealthy");
    const status: WatchdogServiceStatus = {
      name: serviceName,
      healthy: probe.healthy,
      failures,
      restartable: probe.restartable !== false,
      lastMessage,
      lastCheckedAt: now.toISOString(),
      nextRetryAt:
        !probe.healthy && probe.restartable !== false
          ? new Date(now.getTime() + backoffMs).toISOString()
          : undefined,
    };
    this.services.set(serviceName, status);

    if (!probe.healthy) {
      this.audit?.record({
        type: "system.event",
        subject: `watchdog:${serviceName}`,
        details: {
          healthy: false,
          failures,
          message: status.lastMessage,
        },
      });
    }

    if (!probe.healthy && failures >= this.normalizedFailureThreshold) {
      this.safeMode.enter({
        module: `watchdog:${serviceName}`,
        reason: status.lastMessage,
        severity: "warning",
        recommendation:
          probe.restartable === false
            ? "Fix the service configuration and restart manually."
            : "Watchdog stopped the restart loop; inspect logs and restart after fixing the cause.",
      });
    }

    return { ...status };
  }

  restart(): WatchdogStatus {
    this.services.clear();
    this.audit?.record({
      type: "system.event",
      subject: "watchdog:restart",
      details: { restarted: true },
    });
    return this.status();
  }

  status(): WatchdogStatus {
    return {
      enabled: true,
      services: [...this.services.values()].map((service) => ({ ...service })),
      safeMode: this.safeMode.getState(),
    };
  }
}
