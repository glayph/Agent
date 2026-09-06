#!/usr/bin/env node
import process from "node:process";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith("--") && value && !value.startsWith("--")) {
    args.set(key.slice(2), value);
    index += 1;
  }
}

const attempts = Math.max(1, Number(args.get("attempts") || 1));
const intervalMs = Math.max(100, Number(args.get("interval-ms") || 1000));
const timeoutMs = Math.max(500, Number(args.get("timeout-ms") || 3000));
const endpoints = [
  ["core", args.get("core") || "http://127.0.0.1:8000/health"],
  ["gateway", args.get("gateway") || "http://127.0.0.1:18800/gateway/health"],
  ["memory", args.get("memory") || "http://127.0.0.1:18700/health"],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samples = [];

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  for (const [name, url] of endpoints) {
    const started = performance.now();
    let status = 0;
    let ok = false;
    let error = "";
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      ok = response.ok;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const latencyMs = Math.round((performance.now() - started) * 100) / 100;
    samples.push({ attempt, name, ok, status, latencyMs, ...(error ? { error } : {}) });
    console.log(JSON.stringify(samples.at(-1)));
  }
  if (attempt < attempts) await sleep(intervalMs);
}

const failed = samples.filter((sample) => !sample.ok);
const maxLatencyMs = Math.max(...samples.map((sample) => sample.latencyMs));
console.log(
  JSON.stringify({
    ok: failed.length === 0,
    attempts,
    sampleCount: samples.length,
    failedCount: failed.length,
    maxLatencyMs,
  }),
);
process.exitCode = failed.length === 0 ? 0 : 1;
