#!/usr/bin/env node

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  computeRestartDelay,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_RESTART_RESET_AFTER_MS,
  resolveMaxRestarts,
  resolvePositiveDuration,
  restartLimitReached,
} from './miki-24-7-policy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(process.env.MIKI_SOURCE_ROOT || root);
const workspaceDir = path.resolve(process.env.MIKI_WORKSPACE_DIR || root);
const runtimeRoot = path.resolve(process.env.MIKI_RUNTIME_ROOT || workspaceDir);
const dataDir = path.join(workspaceDir, 'data');
const statePath = path.join(dataDir, '24-7-supervisor.json');
const lockPath = path.join(dataDir, '24-7-supervisor.lock');
const gatewayEntry = path.resolve(
  process.env.MIKI_GATEWAY_ENTRY ||
    path.join(sourceRoot, 'packages', 'gateway', 'dist', 'index.js'),
);
const maxRestarts = resolveMaxRestarts(process.env);
const maxBackoffMs = resolvePositiveDuration(
  process.env.MIKI_24_7_MAX_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
);
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

let gateway = null;
let stopping = false;
let restartCount = 0;
let restartTimer = null;
let restartResetTimer = null;

function now() {
  return new Date().toISOString();
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function acquireLock() {
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: now() })}\n`, 'utf8');
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
        if (probeError?.code === 'EPERM') throw probeError;
      }
      if (isAlive) {
        throw new Error(`another 24/7 supervisor is already running (pid ${existing.pid})`);
      }
    }
    try { fs.unlinkSync(lockPath); } catch { /* stale lock cleanup is best effort */ }
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: now() })}\n`, 'utf8');
    fs.closeSync(fd);
  }
}

function releaseLock() {
  try {
    const existing = readJson(lockPath);
    if (!existing || Number(existing.pid) === process.pid) fs.unlinkSync(lockPath);
  } catch { /* process shutdown should not fail on lock cleanup */ }
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
  return new Promise(resolve => {
    restartTimer = setTimeout(() => {
      restartTimer = null;
      resolve();
    }, ms);
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
  let lastError = 'not reachable';
  while (!stopping && gateway === child && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!stopping && gateway === child) {
    console.error(`[miki-24-7] gateway readiness timeout after ${gatewayReadyTimeoutMs}ms (${lastError})`);
    void notify("gateway_readiness_failed", { reason: lastError });
  }
  return false;
}

async function spawnGateway() {
  if (stopping) return;
  if (!fs.existsSync(gatewayEntry)) {
    throw new Error(`gateway build not found: ${gatewayEntry}. Run npm run build:all first.`);
  }
  persist('starting');
  const child = childProcess.spawn(process.execPath, [gatewayEntry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      MIKI_SOURCE_ROOT: sourceRoot,
      MIKI_RUNTIME_ROOT: runtimeRoot,
      MIKI_WORKSPACE_DIR: workspaceDir,
      MIKI_24_7_RUNTIME: '1',
    },
    stdio: 'inherit',
  });
  gateway = child;
  persist('starting', { gatewayStartedAt: now(), gatewayReadyAt: null });
  child.once('error', error => {
    console.error(`[miki-24-7] gateway spawn error: ${error.message}`);
  });
  child.once('exit', (code, signal) => {
    if (gateway === child) gateway = null;
    if (stopping) {
      persist('stopped', { exitCode: code, signal });
      return;
    }
    restartCount += 1;
    persist('restarting', {
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
    if (restartLimitReached(maxRestarts, restartCount)) {
      const reason = `restart limit reached (${maxRestarts})`;
      console.error(`[miki-24-7] ${reason}; entering failed state.`);
      void shutdown('restart limit reached').finally(() => {
        persist('failed', { exitCode: code, signal, reason, failedAt: now() });
        void notify("restart_exhausted", { reason, exitCode: code, signal });
        process.exit(1);
      });
      return;
    }
    const delay = computeRestartDelay(restartCount, maxBackoffMs);
    console.warn(`[miki-24-7] gateway exited (code=${code}, signal=${signal}); restarting in ${delay}ms.`);
    sleep(delay).then(() => {
      if (!stopping) void spawnGateway().catch(error => {
        console.error(`[miki-24-7] restart failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  });

  const ready = await waitForGatewayReady(child);
  if (ready && gateway === child && !stopping) {
    persist('running', { gatewayReadyAt: now() });
    if (restartCount > 0) {
      if (restartResetTimer) clearTimeout(restartResetTimer);
      restartResetTimer = setTimeout(() => {
        restartResetTimer = null;
        restartCount = 0;
        persist('running', { gatewayReadyAt: now(), restartCountReset: true });
      }, restartResetAfterMs);
    }
  } else if (!stopping && gateway === child) {
    child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (restartResetTimer) clearTimeout(restartResetTimer);
  persist('stopping', { signal });
  if (gateway && !gateway.killed) {
    gateway.kill(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 15_000);
      gateway?.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    if (gateway && !gateway.killed) gateway.kill('SIGKILL');
  }
  persist('stopped', { signal });
  releaseLock();
}

async function main() {
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({
      ok: fs.existsSync(gatewayEntry),
      gatewayEntry,
      sourceRoot,
      workspaceDir,
      runtimeRoot,
      maxRestarts,
      maxBackoffMs,
      restartResetAfterMs,
      gatewayReadyTimeoutMs,
    }, null, 2));
    return;
  }
  acquireLock();
  persist('booting');
  process.once('SIGINT', () => void shutdown('SIGINT').finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown('SIGTERM').finally(() => process.exit(0)));
  process.once('uncaughtException', error => {
    console.error(`[miki-24-7] uncaught exception: ${error.stack || error.message}`);
    void shutdown('uncaughtException').finally(() => process.exit(1));
  });
  process.once('unhandledRejection', reason => {
    console.error('[miki-24-7] unhandled rejection:', reason);
    void shutdown('unhandledRejection').finally(() => process.exit(1));
  });
  await spawnGateway();
  await new Promise(() => {});
}

main().catch(error => {
  console.error(`[miki-24-7] fatal: ${error.stack || error.message}`);
  releaseLock();
  process.exit(1);
});
