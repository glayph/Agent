import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type AlertSeverity = "info" | "warning" | "critical";

export interface OperationalAlert {
  id: string;
  createdAt: string;
  severity: AlertSeverity;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AlertSinkOptions {
  filePath?: string;
  webhookUrl?: string;
  cooldownMs?: number;
  timeoutMs?: number;
}

const severityRank: Record<AlertSeverity, number> = {
  info: 1,
  warning: 2,
  critical: 3,
};

function safeDetails(details: Record<string, unknown> | undefined) {
  if (!details) return undefined;
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => {
      const sensitive = /key|token|secret|password|authorization|cookie/i.test(
        key,
      );
      return [key, sensitive ? "[redacted]" : value];
    }),
  );
}

export class OperationalAlertSink {
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private readonly lastSent = new Map<string, number>();

  constructor(private readonly options: AlertSinkOptions = {}) {
    this.cooldownMs = Math.max(0, options.cooldownMs ?? 300_000);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000);
  }

  async emit(
    severity: AlertSeverity,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<{ emitted: boolean; alert: OperationalAlert }> {
    const now = Date.now();
    const previous = this.lastSent.get(code) ?? 0;
    const alert: OperationalAlert = {
      id: crypto.randomUUID(),
      createdAt: new Date(now).toISOString(),
      severity,
      code,
      message: message.slice(0, 500),
      details: safeDetails(details),
    };
    if (now - previous < this.cooldownMs) return { emitted: false, alert };
    this.lastSent.set(code, now);

    if (this.options.filePath) {
      const filePath = path.resolve(this.options.filePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(alert)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Best-effort hardening on filesystems without chmod support.
      }
    }

    if (this.options.webhookUrl) {
      try {
        await fetch(this.options.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(alert),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        // File evidence remains available even when the remote alert sink is down.
      }
    }
    return { emitted: true, alert };
  }
}

export interface HealthAlertSnapshot {
  status?: string;
  memoryPercentage?: number;
  diskPercentage?: number;
  deadLetterJobs?: number;
  providerReady?: boolean;
}

export async function evaluateHealthAlerts(
  sink: OperationalAlertSink,
  snapshot: HealthAlertSnapshot,
  thresholds: {
    memoryPercentage?: number;
    diskPercentage?: number;
  } = {},
): Promise<OperationalAlert[]> {
  const emitted: OperationalAlert[] = [];
  const memoryLimit = thresholds.memoryPercentage ?? 90;
  const diskLimit = thresholds.diskPercentage ?? 90;
  const alertDetails = snapshot as unknown as Record<string, unknown>;
  const emit = async (
    severity: AlertSeverity,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => {
    const result = await sink.emit(severity, code, message, details);
    if (result.emitted) emitted.push(result.alert);
  };

  if (snapshot.status === "failed") {
    await emit(
      "critical",
      "health.failed",
      "Agent health is failed",
      alertDetails,
    );
  } else if (snapshot.status === "degraded") {
    await emit(
      "warning",
      "health.degraded",
      "Agent health is degraded",
      alertDetails,
    );
  }
  if ((snapshot.memoryPercentage ?? 0) >= memoryLimit) {
    await emit(
      "critical",
      "memory.high",
      "Memory usage exceeded threshold",
      alertDetails,
    );
  }
  if ((snapshot.diskPercentage ?? 0) >= diskLimit) {
    await emit(
      "critical",
      "disk.high",
      "Disk usage exceeded threshold",
      alertDetails,
    );
  }
  if ((snapshot.deadLetterJobs ?? 0) > 0) {
    await emit(
      "critical",
      "jobs.dead_letter",
      "Dead-letter jobs require attention",
      alertDetails,
    );
  }
  if (snapshot.providerReady === false) {
    await emit(
      "warning",
      "provider.unavailable",
      "Configured model provider is unavailable",
      alertDetails,
    );
  }
  return emitted;
}

export function isAlertSeverityAtLeast(
  severity: AlertSeverity,
  minimum: AlertSeverity,
): boolean {
  return severityRank[severity] >= severityRank[minimum];
}
