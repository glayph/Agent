#!/usr/bin/env node
/**
 * Long-running operational soak harness. It is intentionally opt-in and
 * bounded by --duration-minutes. It does not claim production alerting or
 * exactly-once external effects; it records observations for review.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
if (process.argv.includes("--help")) {
  console.log(`Usage: node scripts/soak-test.mjs [options]
  --url URL                 health endpoint (default http://127.0.0.1:18800/api/health)
  --duration-minutes N      test duration (default 60)
  --interval-seconds N      probe interval (default 30)
  --output FILE             JSONL output (default data/soak-<timestamp>.jsonl)
  --spawn COMMAND           optional shell command to observe and terminate on exit

The process should be run on the target host. Keep duration at least 60 minutes
for a meaningful soak and inspect memory/fd slopes after completion.`);
  process.exit(0);
}
const url = arg("--url", "http://127.0.0.1:18800/api/health");
const durationMs = Math.max(1, Number(arg("--duration-minutes", "60"))) * 60_000;
const intervalMs = Math.max(1, Number(arg("--interval-seconds", "30"))) * 1_000;
const output = path.resolve(arg("--output", path.join(process.env.MIKI_WORKSPACE_DIR || process.cwd(), "data", `soak-${Date.now()}.jsonl`)));
const spawnCommand = arg("--spawn", "");
const startedAt = Date.now();
let child = null;
let stopping = false;
fs.mkdirSync(path.dirname(output), { recursive: true });
const stream = fs.createWriteStream(output, { flags: "a", encoding: "utf8" });

if (spawnCommand) {
  child = childProcess.spawn(spawnCommand, { shell: true, stdio: "inherit", env: process.env });
  child.once("exit", (code, signal) => {
    if (!stopping) console.error(`Observed command exited early: code=${code} signal=${signal}`);
  });
}

function linuxMetrics() {
  if (process.platform !== "linux" || !child?.pid) return {};
  const proc = `/proc/${child.pid}`;
  let rssKb;
  try {
    const status = fs.readFileSync(path.join(proc, "status"), "utf8");
    rssKb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0);
  } catch {}
  let fdCount;
  try { fdCount = fs.readdirSync(path.join(proc, "fd")).length; } catch {}
  return { childRssKb: rssKb, childFdCount: fdCount };
}

async function probe() {
  const started = Date.now();
  let httpStatus = null;
  let error = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(intervalMs, 15_000)) });
    httpStatus = response.status;
    await response.arrayBuffer();
  } catch (err) { error = err instanceof Error ? err.message : String(err); }
  const record = {
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    host: os.hostname(),
    platform: process.platform,
    url,
    httpStatus,
    probeLatencyMs: Date.now() - started,
    error,
    ...linuxMetrics(),
  };
  stream.write(`${JSON.stringify(record)}\n`);
  console.log(JSON.stringify(record));
  if (httpStatus === null || httpStatus >= 500) return false;
  return true;
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  if (child && !child.killed) {
    child.kill("SIGTERM");
    setTimeout(() => { if (child && !child.killed) child.kill("SIGKILL"); }, 5_000).unref();
  }
  stream.end();
}
process.once("SIGINT", () => stop(130));
process.once("SIGTERM", () => stop(143));

let failures = 0;
const timer = setInterval(async () => {
  const ok = await probe();
  if (!ok) failures += 1;
  if (Date.now() - startedAt >= durationMs) {
    clearInterval(timer);
    console.log(`Soak complete: failures=${failures}; output=${output}`);
    stop(failures > 0 ? 1 : 0);
  }
}, intervalMs);
await probe();
