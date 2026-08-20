#!/usr/bin/env node

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(process.env.MIKI_SOURCE_ROOT || root);
const workspaceDir = path.resolve(process.env.MIKI_WORKSPACE_DIR || root);
const runtimeRoot = path.resolve(process.env.MIKI_RUNTIME_ROOT || workspaceDir);
const dataDir = path.join(workspaceDir, 'data');
const statePath = path.join(dataDir, '24-7-supervisor.json');
const lockPath = path.join(dataDir, '24-7-supervisor.lock');
const gatewayEntry = path.join(sourceRoot, 'packages', 'gateway', 'dist', 'index.js');
const maxRestarts = Number.isFinite(Number(process.env.MIKI_24_7_MAX_RESTARTS))
  ? Math.max(0, Number(process.env.MIKI_24_7_MAX_RESTARTS))
  : 0;
const maxBackoffMs = 60_000;

let gateway = null;
let stopping = false;
let restartCount = 0;
let restartTimer = null;

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

function spawnGateway() {
  if (stopping) return;
  if (!fs.existsSync(gatewayEntry)) {
    throw new Error(`gateway build not found: ${gatewayEntry}. Run npm run build:all first.`);
  }
  persist('starting');
  gateway = childProcess.spawn(process.execPath, [gatewayEntry], {
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
  persist('running', { gatewayStartedAt: now() });
  gateway.once('error', error => {
    console.error(`[miki-24-7] gateway spawn error: ${error.message}`);
  });
  gateway.once('exit', (code, signal) => {
    gateway = null;
    if (stopping) {
      persist('stopped', { exitCode: code, signal });
      return;
    }
    restartCount += 1;
    persist('restarting', { exitCode: code, signal });
    if (maxRestarts > 0 && restartCount > maxRestarts) {
      persist('failed', { exitCode: code, signal, reason: 'restart limit reached' });
      console.error(`[miki-24-7] restart limit reached (${maxRestarts}); stopping.`);
      process.exitCode = 1;
      stopping = true;
      return;
    }
    const delay = Math.min(maxBackoffMs, 1_000 * (2 ** Math.min(restartCount - 1, 6)));
    console.warn(`[miki-24-7] gateway exited (code=${code}, signal=${signal}); restarting in ${delay}ms.`);
    sleep(delay).then(() => {
      if (!stopping) spawnGateway();
    });
  });
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
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
    console.log(JSON.stringify({ ok: fs.existsSync(gatewayEntry), gatewayEntry, sourceRoot, workspaceDir, runtimeRoot }, null, 2));
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
  spawnGateway();
  await new Promise(() => {});
}

main().catch(error => {
  console.error(`[miki-24-7] fatal: ${error.stack || error.message}`);
  releaseLock();
  process.exit(1);
});
