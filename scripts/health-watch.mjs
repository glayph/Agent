#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const once = process.argv.includes("--once");
const healthUrl =
  process.env.MIKI_HEALTH_URL || "http://127.0.0.1:18800/gateway/health";
const alertFile =
  process.env.MIKI_ALERT_FILE || path.resolve("data", "alerts.jsonl");
const webhookUrl = process.env.MIKI_ALERT_WEBHOOK || "";
const pollMs = Math.max(
  5_000,
  Number(process.env.MIKI_HEALTH_POLL_MS || 60_000),
);
const memoryLimit = Math.min(
  100,
  Math.max(1, Number(process.env.MIKI_MEMORY_LIMIT || 90)),
);
const diskLimit = Math.min(
  100,
  Math.max(1, Number(process.env.MIKI_DISK_LIMIT || 90)),
);
const cooldownMs = Math.max(
  0,
  Number(process.env.MIKI_ALERT_COOLDOWN_MS || 300_000),
);
const lastSent = new Map();
let stopping = false;

function redact(value) {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /key|token|secret|password|authorization|cookie/i.test(key)
        ? "[redacted]"
        : item,
    ]),
  );
}
async function emit(severity, code, message, details = {}) {
  const now = Date.now();
  if (now - (lastSent.get(code) || 0) < cooldownMs) return;
  lastSent.set(code, now);
  const alert = {
    id: crypto.randomUUID(),
    createdAt: new Date(now).toISOString(),
    severity,
    code,
    message,
    details: redact(details),
  };
  fs.mkdirSync(path.dirname(path.resolve(alertFile)), { recursive: true });
  fs.appendFileSync(path.resolve(alertFile), `${JSON.stringify(alert)}\n`, {
    mode: 0o600,
  });
  try {
    fs.chmodSync(path.resolve(alertFile), 0o600);
  } catch {}
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alert),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      console.error(
        `[health-watch] webhook failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.error(`[health-watch] ${severity} ${code}: ${message}`);
}
async function check() {
  let body;
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    body = await response.json().catch(() => ({}));
    if (!response.ok)
      await emit(
        "critical",
        "health.http",
        `Health endpoint returned HTTP ${response.status}`,
        { status: response.status },
      );
  } catch (error) {
    await emit(
      "critical",
      "health.unreachable",
      "Health endpoint is unreachable",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return false;
  }
  const snapshot = body?.system || body?.health || body;
  const status = body?.status || snapshot?.status;
  if (status === "failed")
    await emit("critical", "health.failed", "Agent health is failed", {
      status,
    });
  else if (status === "degraded")
    await emit("warning", "health.degraded", "Agent health is degraded", {
      status,
    });
  const memory = Number(
    snapshot?.memory?.percentage ?? snapshot?.memoryPercentage ?? 0,
  );
  const disk = Number(
    snapshot?.disk?.percentage ?? snapshot?.diskPercentage ?? 0,
  );
  if (memory >= memoryLimit)
    await emit("critical", "memory.high", "Memory usage exceeded threshold", {
      memoryPercentage: memory,
      limit: memoryLimit,
    });
  if (disk >= diskLimit && disk > 0)
    await emit("critical", "disk.high", "Disk usage exceeded threshold", {
      diskPercentage: disk,
      limit: diskLimit,
    });
  const deadLetterJobs = Number(
    snapshot?.jobs?.dead_letter ?? snapshot?.deadLetterJobs ?? 0,
  );
  if (deadLetterJobs > 0)
    await emit(
      "critical",
      "jobs.dead_letter",
      "Dead-letter jobs require attention",
      { deadLetterJobs },
    );
  return true;
}
async function main() {
  do {
    await check();
    if (!once) await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (!stopping && !once);
}
process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
