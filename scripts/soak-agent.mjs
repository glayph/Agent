#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

function numberArg(name, fallback, minimum) {
  const value = Number(arg(name, String(fallback)));
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node scripts/soak-agent.mjs [--url GATEWAY_ORIGIN] [--health-path /gateway/health] [--metrics-url OPTIONAL_EXPORTER_URL] [--duration-minutes N | --duration-hours N] [--interval-ms N] [--request-timeout-ms N] [--output PATH] [--api-key-env NAME]",
  );
  process.exit(0);
}

const baseUrl = arg("--url", "http://127.0.0.1:18800").replace(/\/$/, "");
const healthPath = arg("--health-path", "/gateway/health");
const healthUrl = `${baseUrl}${healthPath.startsWith("/") ? healthPath : `/${healthPath}`}`;
const metricsUrl = arg("--metrics-url", "").trim();
const durationHoursIndex = process.argv.indexOf("--duration-hours");
const durationMs = durationHoursIndex >= 0
  ? numberArg("--duration-hours", 24, 0.001) * 3_600_000
  : numberArg("--duration-minutes", 10, 0.01) * 60_000;
const intervalMs = numberArg("--interval-ms", 10_000, 250);
const requestTimeoutMs = numberArg("--request-timeout-ms", 5_000, 250);
const maxSamples = numberArg("--max-samples", 100_000, 1);
const outputPath = arg("--output", path.resolve("soak-report.json"));
const apiKeyEnv = arg("--api-key-env", "API_KEY_SECRET");
const apiKey = process.env[apiKeyEnv]?.trim();

const startedAt = new Date().toISOString();
const samples = [];
let successfulHealthChecks = 0;
let failedHealthChecks = 0;
let metricsFailures = 0;
const healthStateCounts = { ok: 0, degraded: 0, unhealthy: 0, unknown: 0 };
let stopped = false;

function metricValue(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escaped}(?:\\{[^}]*\\})?\\s+([-+0-9.eE]+)$`, "m"));
  return match ? Number(match[1]) : null;
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchWithTimeout(url, init = {}) {
  // AbortSignal.timeout remains active while the caller consumes the response body.
  return fetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
}

async function sample() {
  const sampledAt = new Date().toISOString();
  const start = performance.now();
  let healthStatus = null;
  let healthState = null;
  let metricsStatus = null;
  let rssBytes = null;
  let heapUsedBytes = null;
  let externalBytes = null;
  let openFileDescriptors = null;
  let activeResources = null;
  let eventLoopP99Ms = null;
  let activeRuns = null;
  let outboxPending = null;
  let resourceActiveLeases = null;
  let resourceWaiting = null;
  let resourceCapacityUnits = null;
  let resourceUsedUnits = null;
  let error = null;
  let healthPayload = null;

  try {
    const health = await fetchWithTimeout(healthUrl, {
      headers: apiKey ? { "x-api-key": apiKey } : undefined,
    });
    healthStatus = health.status;
    const contentType = health.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      healthPayload = await health.json();
      healthState = typeof healthPayload?.status === "string" ? healthPayload.status : null;
    }
    if (healthState === "ok" || healthState === "degraded" || healthState === "unhealthy") healthStateCounts[healthState] += 1;
    else healthStateCounts.unknown += 1;
    const healthy = health.ok && healthPayload?.ok !== false && healthState !== "unhealthy";
    if (healthy) successfulHealthChecks += 1;
    else {
      failedHealthChecks += 1;
      error = health.ok ? "health_report_unhealthy" : `health_http_${health.status}`;
    }
    const checks = healthPayload?.checks || {};
    const resources = healthPayload?.resources || {};
    rssBytes = numeric(resources.process_rss_bytes);
    heapUsedBytes = numeric(resources.process_heap_used_bytes);
    externalBytes = numeric(resources.process_external_bytes);
    openFileDescriptors = numeric(resources.process_open_file_descriptors);
    activeResources = numeric(resources.process_active_resources);
    eventLoopP99Ms = numeric(checks.event_loop?.p99_ms);
    activeRuns = numeric(checks.runs?.active);
    outboxPending = numeric(checks.outbox?.pending);
    const arbitration = healthPayload?.resource_arbitration;
    resourceActiveLeases = numeric(arbitration?.activeLeases);
    resourceWaiting = numeric(arbitration?.waiting);
    if (Array.isArray(arbitration?.byResource)) {
      resourceCapacityUnits = arbitration.byResource.reduce((sum, item) => sum + (numeric(item?.capacity) ?? 0), 0);
      resourceUsedUnits = arbitration.byResource.reduce((sum, item) => sum + (numeric(item?.units) ?? 0), 0);
    }
  } catch (cause) {
    failedHealthChecks += 1;
    error = cause?.name === "AbortError" ? "health_timeout" : "health_unreachable";
  }

  if (metricsUrl) {
    try {
      const response = await fetchWithTimeout(metricsUrl, {
        headers: apiKey ? { "x-api-key": apiKey } : undefined,
      });
      metricsStatus = response.status;
      if (response.ok) {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const payload = await response.json();
          const gauges = payload?.collector?.gauges || payload?.gauges || {};
          rssBytes = numeric(gauges.process_rss_bytes) ?? rssBytes;
          heapUsedBytes = numeric(gauges.process_heap_used_bytes) ?? heapUsedBytes;
          externalBytes = numeric(gauges.process_external_bytes) ?? externalBytes;
          openFileDescriptors = numeric(gauges.process_open_file_descriptors) ?? openFileDescriptors;
          activeResources = numeric(gauges.process_active_resources) ?? activeResources;
        } else {
          const text = await response.text();
          rssBytes = metricValue(text, "miki_process_rss_bytes") ?? rssBytes;
          heapUsedBytes = metricValue(text, "miki_process_heap_used_bytes") ?? heapUsedBytes;
          externalBytes = metricValue(text, "miki_process_external_bytes") ?? externalBytes;
          openFileDescriptors = metricValue(text, "miki_process_open_file_descriptors") ?? openFileDescriptors;
          activeResources = metricValue(text, "miki_process_active_resources") ?? activeResources;
        }
      } else {
        metricsFailures += 1;
        if (!error) error = `metrics_http_${response.status}`;
      }
    } catch (cause) {
      metricsFailures += 1;
      if (!error) error = cause?.name === "AbortError" ? "metrics_timeout" : "metrics_unreachable";
    }
  } else {
    // The gateway's local health response is the primary metrics source. An
    // optional exporter can be supplied when additional Prometheus metrics exist.
    metricsStatus = healthStatus;
    if (rssBytes === null || activeResources === null) {
      metricsFailures += 1;
      if (!error) error = "health_metrics_missing";
    }
  }

  const sampleRecord = {
    timestamp: sampledAt,
    latencyMs: Math.round((performance.now() - start) * 100) / 100,
    healthStatus,
    healthState,
    metricsStatus,
    rssBytes,
    heapUsedBytes,
    externalBytes,
    openFileDescriptors,
    activeResources,
    eventLoopP99Ms,
    activeRuns,
    outboxPending,
    resourceActiveLeases,
    resourceWaiting,
    resourceCapacityUnits,
    resourceUsedUnits,
    error,
  };
  samples.push(sampleRecord);
  if (samples.length > maxSamples) samples.shift();
  return sampleRecord;
}

function summarize(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) return null;
  const sorted = [...filtered].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}

function stop() {
  stopped = true;
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(
  `Starting Agent Miki soak: ${healthUrl} for ${durationMs / 60000} minute(s) at ${intervalMs}ms intervals.`,
);
const deadline = Date.now() + durationMs;
while (!stopped && Date.now() < deadline) {
  const record = await sample();
  if (record.error) console.warn(`soak sample warning: ${record.error}`);
  const remaining = Math.max(0, Math.min(intervalMs, deadline - Date.now()));
  if (remaining > 0)
    await new Promise((resolve) => setTimeout(resolve, remaining));
}

const report = {
  schemaVersion: 3,
  target: baseUrl,
  healthUrl,
  metricsUrl: metricsUrl || null,
  intendedDurationSeconds: Math.round(durationMs / 1000),
  completedNormally: !stopped && Date.now() >= deadline,
  startedAt,
  finishedAt: new Date().toISOString(),
  durationSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
  intervalMs,
  stoppedBySignal: stopped,
  successfulHealthChecks,
  failedHealthChecks,
  healthStateCounts,
  metricsFailures,
  samples: samples.length,
  latency: summarize(samples.map((item) => item.latencyMs)),
  rssBytes: summarize(samples.map((item) => item.rssBytes)),
  heapUsedBytes: summarize(samples.map((item) => item.heapUsedBytes)),
  externalBytes: summarize(samples.map((item) => item.externalBytes)),
  openFileDescriptors: summarize(samples.map((item) => item.openFileDescriptors)),
  activeResources: summarize(samples.map((item) => item.activeResources)),
  eventLoopP99Ms: summarize(samples.map((item) => item.eventLoopP99Ms)),
  activeRuns: summarize(samples.map((item) => item.activeRuns)),
  outboxPending: summarize(samples.map((item) => item.outboxPending)),
  resourceActiveLeases: summarize(samples.map((item) => item.resourceActiveLeases)),
  resourceWaiting: summarize(samples.map((item) => item.resourceWaiting)),
  resourceCapacityUnits: summarize(samples.map((item) => item.resourceCapacityUnits)),
  resourceUsedUnits: summarize(samples.map((item) => item.resourceUsedUnits)),
  errorSamples: samples.filter((item) => item.error),
  errorCounts: samples.reduce((counts, item) => {
    if (item.error) counts[item.error] = (counts[item.error] || 0) + 1;
    return counts;
  }, {}),
  lastSample: samples.at(-1) || null,
};

fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
console.log(`Soak report written to ${outputPath}`);
console.log(
  JSON.stringify(
    {
      durationSeconds: report.durationSeconds,
      successfulHealthChecks,
      failedHealthChecks,
      healthStateCounts,
      metricsFailures,
      rssBytes: report.rssBytes,
      openFileDescriptors: report.openFileDescriptors,
      activeResources: report.activeResources,
      resourceWaiting: report.resourceWaiting,
    },
    null,
    2,
  ),
);
process.exitCode = failedHealthChecks > 0 || metricsFailures > 0 ? 1 : stopped ? 130 : 0;
