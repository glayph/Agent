#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  computeRestartDelay,
  DEFAULT_RESTART_RESET_AFTER_MS,
  resolveMaxBackoffMs,
  resolvePositiveDuration,
} from "./miki-24-7-policy.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const sourceRoot = path.resolve(process.env.MIKI_SOURCE_ROOT || root);
const workspaceDir = path.resolve(process.env.MIKI_WORKSPACE_DIR || root);
const runtimeRoot = path.resolve(process.env.MIKI_RUNTIME_ROOT || workspaceDir);
const configDir = path.resolve(process.env.MIKI_CONFIG_DIR || path.join(workspaceDir, "config"));
const dataDir = path.resolve(process.env.MIKI_DATA_DIR || path.join(workspaceDir, "data"));
const statePath = path.join(dataDir, "24-7-supervisor.json");
const lockPath = path.join(dataDir, "24-7-supervisor.lock");
const gatewayStopRequestPath = path.join(dataDir, "24-7-gateway-stop.request");
// The gateway writes this file when the dashboard asks for a restart; it then exits with RESTART_EXIT_CODE.
const gatewayRestartRequestPath = path.join(dataDir, "24-7-gateway-restart.request");
const RESTART_EXIT_CODE = 75;
const gatewayEntry = path.resolve(
  process.env.MIKI_GATEWAY_ENTRY ||
    path.join(sourceRoot, "packages", "gateway", "dist", "index.js"),
);
const maxBackoffMs = resolveMaxBackoffMs(process.env.MIKI_24_7_MAX_BACKOFF_MS);
const restartResetAfterMs = resolvePositiveDuration(
  process.env.MIKI_24_7_RESTART_RESET_AFTER_MS,
  DEFAULT_RESTART_RESET_AFTER_MS,
);
const gatewayPort = Number.isFinite(Number(process.env.GATEWAY_PORT))
  ? Math.max(1, Number(process.env.GATEWAY_PORT))
  : 18_800;
const gatewayReadyTimeoutMs = Number.isFinite(
  Number(process.env.MIKI_24_7_READY_TIMEOUT_MS),
)
  ? Math.max(5_000, Number(process.env.MIKI_24_7_READY_TIMEOUT_MS))
  : 45_000;
const webhookUrl = String(process.env.MIKI_24_7_WEBHOOK_URL || "").trim();
// Hang watchdog: a light /gateway/live probe every 10 s; a deep /gateway/health check every third probe. After
// three failures in a row the gateway is killed and restarted. All three numbers can be changed (nothing is fixed).
const watchdogIntervalMs = resolvePositiveDuration(process.env.MIKI_WATCHDOG_INTERVAL_MS, 10_000);
const watchdogTimeoutMs = resolvePositiveDuration(process.env.MIKI_WATCHDOG_TIMEOUT_MS, 4_000);
const watchdogFailureLimit = Math.max(1, Math.floor(Number(process.env.MIKI_WATCHDOG_FAILURES)) || 3);
const watchdogDeepEvery = Math.max(1, Math.floor(Number(process.env.MIKI_WATCHDOG_DEEP_EVERY)) || 3);

let gateway = null;
let stopping = false;
let restartCount = 0;
let restartTimer = null;
let restartResetTimer = null;
let heartbeatTimer = null;
let watchdogTimer = null;

function now() {
  return new Date().toISOString();
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function acquireLock() {
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(
      fd,
      `${JSON.stringify({ pid: process.pid, startedAt: now() })}\n`,
      "utf8",
    );
    fs.closeSync(fd);
    return;
  } catch (error) {
    const existing = readJson(lockPath);
    if (existing?.pid) {
      let isAlive = false;
      try {
        process.kill(Number(existing.pid), 0);
        isAlive = true;
      } catch (probeError) {
        if (probeError?.code === "EPERM") throw probeError;
      }
      if (isAlive) {
        throw new Error(
          `another 24/7 supervisor is already running (pid ${existing.pid})`,
        );
      }
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* stale lock cleanup is best effort */
    }
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(
      fd,
      `${JSON.stringify({ pid: process.pid, startedAt: now() })}\n`,
      "utf8",
    );
    fs.closeSync(fd);
  }
}

function releaseLock() {
  try {
    const existing = readJson(lockPath);
    if (!existing || Number(existing.pid) === process.pid)
      fs.unlinkSync(lockPath);
  } catch {
    /* process shutdown should not fail on lock cleanup */
  }
}

function persist(status, extra = {}) {
  writeJsonAtomic(statePath, {
    pid: process.pid,
    status,
    gatewayPid: gateway?.pid ?? null,
    restartCount,
    updatedAt: now(),
    workspaceDir,
    sourceRoot,
    runtimeRoot,
    ...extra,
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    restartTimer = setTimeout(() => {
      restartTimer = null;
      resolve();
    }, ms);
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(exited);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", () => finish(true));
  });
}

async function notify(event, details = {}) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event,
        timestamp: now(),
        service: "agent-miki-supervisor",
        ...details,
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Notification failure must never interfere with recovery.
  }
}

async function waitForGatewayReady(child) {
  const deadline = Date.now() + gatewayReadyTimeoutMs;
  let lastError = "not reachable";
  while (!stopping && gateway === child && Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${gatewayPort}/gateway/health`,
        {
          signal: AbortSignal.timeout(2_000),
        },
      );
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!stopping && gateway === child) {
    console.error(
      `[miki-24-7] gateway readiness timeout after ${gatewayReadyTimeoutMs}ms (${lastError})`,
    );
    void notify("gateway_readiness_failed", { reason: lastError });
  }
  return false;
}

/**
 * Looks for a gateway that is alive as a process but no longer answers (event loop stuck, deadlock, SIGSTOP).
 * Only `/gateway/live` is needed for that; a deep `/gateway/health` check runs every few probes and counts as a
 * failure only when it answers 503 (the database failed). A degraded gateway (model or network trouble) answers 200
 * and is left alone, because restarting it would not help.
 */
async function probeGateway(deep) {
  const path = deep ? "/gateway/health" : "/gateway/live";
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
      signal: AbortSignal.timeout(watchdogTimeoutMs),
    });
    // An older gateway build has no /gateway/live: fall back to the health URL it does have.
    if (response.status === 404 && !deep) return await probeGateway(true);
    return response.ok ? null : `${path} answered HTTP ${response.status}`;
  } catch (error) {
    return `${path} did not answer (${error instanceof Error ? error.message : String(error)})`;
  }
}

function stopWatchdog() {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = null;
}

function startWatchdog(child) {
  stopWatchdog();
  let failures = 0;
  let probes = 0;
  const tick = async () => {
    watchdogTimer = null;
    if (stopping || gateway !== child) return;
    probes += 1;
    const failure = await probeGateway(probes % watchdogDeepEvery === 0);
    if (stopping || gateway !== child) return;
    if (failure) {
      failures += 1;
      console.warn(`[miki-24-7] watchdog: ${failure} (${failures}/${watchdogFailureLimit})`);
      if (failures >= watchdogFailureLimit) {
        const reason = `gateway_unresponsive:${failure}`;
        console.error(`[miki-24-7] watchdog: gateway pid ${child.pid} is unresponsive; restarting it.`);
        persist("restarting", { lastFailureAt: now(), lastFailureReason: reason, watchdogRestart: true });
        void notify("gateway_unresponsive", { reason, restartCount });
        // SIGKILL: a hung or stopped process never handles SIGTERM. The exit handler restarts it with the usual backoff.
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        return;
      }
    } else {
      failures = 0;
    }
    watchdogTimer = setTimeout(() => void tick(), watchdogIntervalMs);
    watchdogTimer.unref?.();
  };
  watchdogTimer = setTimeout(() => void tick(), watchdogIntervalMs);
  watchdogTimer.unref?.();
}

/**
 * Restarts the gateway after the backoff delay. A failure to even start it (spawn error, missing build for a moment)
 * is retried with the same growing delay; the supervisor never gives up and never exits because of it.
 */
function scheduleRestart(code, signal) {
  const delay = computeRestartDelay(restartCount, maxBackoffMs);
  console.warn(
    `[miki-24-7] gateway exited (code=${code}, signal=${signal}); restarting in ${delay}ms.`,
  );
  sleep(delay).then(() => {
    if (stopping) return;
    void spawnGateway().catch((error) => {
      const reason = `restart_spawn_failed:${error instanceof Error ? error.message : String(error)}`;
      restartCount += 1;
      console.error(`[miki-24-7] ${reason}; retrying with backoff.`);
      persist("restarting", { reason, lastFailureAt: now(), lastFailureReason: reason, restartCount });
      void notify("gateway_restart_failed", { reason, restartCount });
      scheduleRestart(code, signal);
    });
  });
}

async function spawnGateway() {
  if (stopping) return;
  if (!fs.existsSync(gatewayEntry)) {
    throw new Error(
      `gateway build not found: ${gatewayEntry}. Run npm run build:all first.`,
    );
  }
  persist("starting");
  try { fs.unlinkSync(gatewayStopRequestPath); } catch {}
  const child = childProcess.spawn(process.execPath, [gatewayEntry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      MIKI_SOURCE_ROOT: sourceRoot,
      MIKI_RUNTIME_ROOT: runtimeRoot,
      MIKI_WORKSPACE_DIR: workspaceDir,
      MIKI_DATA_DIR: dataDir,
      MIKI_CONFIG_DIR: configDir,
      MIKI_GATEWAY_STOP_FILE: gatewayStopRequestPath,
      MIKI_GATEWAY_RESTART_FILE: gatewayRestartRequestPath,
      MIKI_24_7_RUNTIME: "1",
      MIKI_24_7_STOP_FILE: gatewayStopRequestPath,
    },
    stdio: "inherit",
  });
  gateway = child;
  persist("starting", { gatewayStartedAt: now(), gatewayReadyAt: null });
  child.once("error", (error) => {
    console.error(`[miki-24-7] gateway spawn error: ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    if (gateway === child) { gateway = null; stopWatchdog(); }
    if (!stopping && fs.existsSync(gatewayStopRequestPath)) {
      try { fs.unlinkSync(gatewayStopRequestPath); } catch {}
      void shutdown("gateway_shutdown").finally(() => persist("stopped", { exitCode: code, signal, shutdownRequested: true }));
      return;
    }
    if (stopping) {
      persist("stopped", { exitCode: code, signal });
      return;
    }
    // A requested restart (exit code 75, or the request file) is replaced at once: there is no backoff and the
    // crash counter is not raised, because nothing failed.
    const restartRequested = code === RESTART_EXIT_CODE || fs.existsSync(gatewayRestartRequestPath);
    if (restartRequested) {
      try { fs.unlinkSync(gatewayRestartRequestPath); } catch {}
      console.warn("[miki-24-7] gateway restart requested; starting a new gateway process now.");
      persist("restarting", { exitCode: code, signal, restartRequestedAt: now(), lastFailureReason: "gateway_restart_requested" });
      void notify("gateway_restart_requested", { exitCode: code, restartCount });
      void spawnGateway().catch((error) => {
        const reason = `restart_spawn_failed:${error instanceof Error ? error.message : String(error)}`;
        restartCount += 1;
        console.error(`[miki-24-7] ${reason}; retrying with backoff.`);
        persist("restarting", { reason, lastFailureAt: now(), lastFailureReason: reason, restartCount });
        void notify("gateway_restart_failed", { reason, restartCount });
        scheduleRestart(code, signal);
      });
      return;
    }
    restartCount += 1;
    persist("restarting", {
      exitCode: code,
      signal,
      lastFailureAt: now(),
      lastFailureReason: `gateway_exit:${code ?? signal ?? "unknown"}`,
    });
    void notify("gateway_crashed", {
      exitCode: code,
      signal,
      restartCount,
    });
    // There is no restart limit: the gateway is restarted for as long as the
    // supervisor runs, with the wait capped at maxBackoffMs (three minutes).
    scheduleRestart(code, signal);
  });

  const ready = await waitForGatewayReady(child);
  if (ready && gateway === child && !stopping) {
    persist("running", { gatewayReadyAt: now() });
    startWatchdog(child);
    if (restartCount > 0) {
      if (restartResetTimer) clearTimeout(restartResetTimer);
      restartResetTimer = setTimeout(() => {
        restartResetTimer = null;
        restartCount = 0;
        persist("running", { gatewayReadyAt: now(), restartCountReset: true });
      }, restartResetAfterMs);
    }
  } else if (!stopping && gateway === child) {
    child.kill(process.platform === "win32" ? undefined : "SIGTERM");
    if (!(await waitForExit(child, 5_000)) && gateway === child) {
      child.kill("SIGKILL");
      await waitForExit(child, 5_000);
    }
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (restartResetTimer) clearTimeout(restartResetTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  stopWatchdog();
  persist("stopping", { signal });
  const child = gateway;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
    if (!(await waitForExit(child, 15_000))) {
      child.kill("SIGKILL");
      await waitForExit(child, 5_000);
    }
  }
  persist("stopped", { signal });
  releaseLock();
}

async function main() {
  if (process.argv.includes("--check")) {
    console.log(
      JSON.stringify(
        {
          ok: fs.existsSync(gatewayEntry),
          gatewayEntry,
          sourceRoot,
          workspaceDir,
          runtimeRoot,
          maxRestarts: "unlimited",
          maxBackoffMs,
          restartResetAfterMs,
          gatewayReadyTimeoutMs,
        },
        null,
        2,
      ),
    );
    return;
  }
  acquireLock();
  persist("booting");
  heartbeatTimer = setInterval(() => {
    if (!stopping && gateway) persist("running", { heartbeatAt: now() });
  }, 30_000);
  process.once(
    "SIGINT",
    () => void shutdown("SIGINT").finally(() => process.exit(0)),
  );
  process.once(
    "SIGTERM",
    () => void shutdown("SIGTERM").finally(() => process.exit(0)),
  );
  process.once("uncaughtException", (error) => {
    console.error(
      `[miki-24-7] uncaught exception: ${error.stack || error.message}`,
    );
    void shutdown("uncaughtException").finally(() => process.exit(1));
  });
  process.once("unhandledRejection", (reason) => {
    console.error("[miki-24-7] unhandled rejection:", reason);
    void shutdown("unhandledRejection").finally(() => process.exit(1));
  });
  await spawnGateway();
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(`[miki-24-7] fatal: ${error.stack || error.message}`);
  releaseLock();
  process.exit(1);
});
