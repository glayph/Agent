#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberArg(name, fallback, minimum) {
  const value = Number(arg(name, String(fallback)));
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node scripts/soak-agent.mjs [--url URL] [--duration-minutes N] [--interval-ms N] [--request-timeout-ms N] [--output PATH] [--api-key-env NAME]",
  );
  process.exit(0);
}

const baseUrl = arg("--url", "http://127.0.0.1:18800").replace(/\/$/, "");
const durationMs = numberArg("--duration-minutes", 10, 0.01) * 60_000;
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
let stopped = false;

function metricValue(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escaped}\\s+([-+0-9.eE]+)$`, "m"));
  return match ? Number(match[1]) : null;
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sample() {
  const sampledAt = new Date().toISOString();
  const start = performance.now();
  let healthStatus = null;
  let metricsStatus = null;
  let rssBytes = null;
  let openFileDescriptors = null;
  let activeResources = null;
  let error = null;

  try {
    const health = await fetchWithTimeout(`${baseUrl}/health`);
    healthStatus = health.status;
    if (health.ok) successfulHealthChecks += 1;
    else failedHealthChecks += 1;
  } catch (cause) {
    failedHealthChecks += 1;
    error = cause?.name === "AbortError" ? "health_timeout" : "health_unreachable";
  }

  try {
    const headers = apiKey ? { "x-api-key": apiKey } : undefined;
    const response = await fetchWithTimeout(`${baseUrl}/metrics/prometheus`, {
      headers,
    });
    metricsStatus = response.status;
    if (response.ok) {
      const text = await response.text();
      rssBytes = metricValue(text, "miki_process_rss_bytes");
      openFileDescriptors = metricValue(text, "miki_process_open_file_descriptors");
      activeResources = metricValue(text, "miki_process_active_resources");
    } else {
      metricsFailures += 1;
    }
  } catch (cause) {
    metricsFailures += 1;
    if (!error) error = cause?.name === "AbortError" ? "metrics_timeout" : "metrics_unreachable";
  }

  const sampleRecord = {
    timestamp: sampledAt,
    latencyMs: Math.round((performance.now() - start) * 100) / 100,
    healthStatus,
    metricsStatus,
    rssBytes,
    openFileDescriptors,
    activeResources,
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
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
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

console.log(`Starting Agent Miki soak: ${baseUrl} for ${durationMs / 60000} minute(s) at ${intervalMs}ms intervals.`);
const deadline = Date.now() + durationMs;
while (!stopped && Date.now() < deadline) {
  const record = await sample();
  if (record.error) console.warn(`soak sample warning: ${record.error}`);
  const remaining = Math.max(0, Math.min(intervalMs, deadline - Date.now()));
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

const report = {
  schemaVersion: 1,
  target: baseUrl,
  startedAt,
  finishedAt: new Date().toISOString(),
  durationSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
  intervalMs,
  stoppedBySignal: stopped,
  successfulHealthChecks,
  failedHealthChecks,
  metricsFailures,
  samples: samples.length,
  latency: summarize(samples.map((item) => item.latencyMs)),
  rssBytes: summarize(samples.map((item) => item.rssBytes)),
  openFileDescriptors: summarize(samples.map((item) => item.openFileDescriptors)),
  activeResources: summarize(samples.map((item) => item.activeResources)),
  lastSample: samples.at(-1) || null,
};

fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`Soak report written to ${outputPath}`);
console.log(JSON.stringify({
  durationSeconds: report.durationSeconds,
  successfulHealthChecks,
  failedHealthChecks,
  metricsFailures,
  rssBytes: report.rssBytes,
  openFileDescriptors: report.openFileDescriptors,
}, null, 2));
process.exitCode = failedHealthChecks > 0 ? 1 : 0;
