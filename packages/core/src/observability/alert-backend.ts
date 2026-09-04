import * as crypto from "node:crypto";
import type { ResourceAlert } from "./resource-monitor.js";
import { globalMetricsCollector } from "../metrics-collector.js";

export interface AlertPayload {
  id: string;
  source: "agent-miki";
  type: "resource";
  code: ResourceAlert["code"];
  severity: ResourceAlert["severity"];
  message: string;
  timestamp: string;
  snapshot: ResourceAlert["snapshot"];
  threshold: number;
}

export interface AlertBackendOptions {
  webhookUrl?: string;
  webhookToken?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onError?: (message: string) => void;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validateWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MIKI_ALERT_WEBHOOK_URL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("MIKI_ALERT_WEBHOOK_URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "MIKI_ALERT_WEBHOOK_URL must not contain credentials, query parameters, or fragments",
    );
  }
  return url.toString();
}

function alertId(alert: ResourceAlert): string {
  return crypto
    .createHash("sha256")
    .update(
      `${alert.dedupeKey}|${alert.code}|${alert.severity}|${alert.message}|${alert.threshold}`,
    )
    .digest("hex")
    .slice(0, 32);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && /timeout|abort/i.test(error.message)) {
    return "Alert webhook timed out.";
  }
  return "Alert webhook delivery failed.";
}

export class AlertBackend {
  private readonly webhookUrl?: string;
  private readonly webhookToken?: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly minIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onError: (message: string) => void;
  private lastSentAt = new Map<string, number>();

  constructor(options: AlertBackendOptions = {}) {
    const configuredUrl =
      options.webhookUrl ?? process.env.MIKI_ALERT_WEBHOOK_URL?.trim();
    this.webhookUrl = configuredUrl
      ? validateWebhookUrl(configuredUrl)
      : undefined;
    this.webhookToken =
      options.webhookToken ?? process.env.MIKI_ALERT_WEBHOOK_TOKEN?.trim();
    this.timeoutMs = Math.min(
      30000,
      Math.max(
        1000,
        options.timeoutMs ??
          positiveInt(process.env.MIKI_ALERT_TIMEOUT_MS, 5000),
      ),
    );
    this.maxAttempts = Math.min(
      3,
      Math.max(
        1,
        options.maxAttempts ??
          positiveInt(process.env.MIKI_ALERT_MAX_ATTEMPTS, 2),
      ),
    );
    this.minIntervalMs = Math.max(
      0,
      options.minIntervalMs ??
        positiveInt(process.env.MIKI_ALERT_MIN_INTERVAL_MS, 60000),
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.onError =
      options.onError ?? ((message) => console.warn(`[alert] ${message}`));
  }

  isConfigured(): boolean {
    return Boolean(this.webhookUrl);
  }

  async notify(alert: ResourceAlert): Promise<void> {
    const payload: AlertPayload = {
      id: alertId(alert),
      source: "agent-miki",
      type: "resource",
      code: alert.code,
      severity: alert.severity,
      message: alert.message,
      timestamp: alert.snapshot.timestamp,
      snapshot: alert.snapshot,
      threshold: alert.threshold,
    };
    globalMetricsCollector.incrementCounter("alerts_total", 1, {
      code: alert.code,
      severity: alert.severity,
    });
    if (!this.webhookUrl) return;

    const lastSent = this.lastSentAt.get(payload.id);
    if (lastSent !== undefined && this.now() - lastSent < this.minIntervalMs) {
      globalMetricsCollector.incrementCounter("alerts_suppressed_total", 1, {
        code: alert.code,
      });
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        timer.unref?.();
        try {
          const response = await this.fetchImpl(this.webhookUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(this.webhookToken
                ? { authorization: `Bearer ${this.webhookToken}` }
                : {}),
              "x-miki-alert-id": payload.id,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
        } finally {
          clearTimeout(timer);
        }
        this.lastSentAt.set(payload.id, this.now());
        globalMetricsCollector.incrementCounter("alerts_delivered_total", 1, {
          code: alert.code,
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxAttempts) continue;
      }
    }

    globalMetricsCollector.incrementCounter("alerts_failed_total", 1, {
      code: alert.code,
    });
    this.onError(safeErrorMessage(lastError));
  }
}

export function createAlertBackend(
  options: AlertBackendOptions = {},
): AlertBackend {
  return new AlertBackend(options);
}
