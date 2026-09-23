#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supervisor = path.join(root, "scripts", "miki-24-7.mjs");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(50);
  }
  throw new Error("Timed out waiting for supervisor state");
}

function spawnSupervisor(workspaceDir, gatewayEntry, port, extra = {}) {
  return childProcess.spawn(process.execPath, [supervisor], {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      MIKI_SOURCE_ROOT: root,
      MIKI_WORKSPACE_DIR: workspaceDir,
      MIKI_RUNTIME_ROOT: workspaceDir,
      MIKI_GATEWAY_ENTRY: gatewayEntry,
      GATEWAY_PORT: String(port),
      MIKI_24_7_READY_TIMEOUT_MS: "5000",
      MIKI_24_7_MAX_BACKOFF_MS: "1000",
      MIKI_24_7_RESTART_RESET_AFTER_MS: "60000",
      ...extra,
    },
  });
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function runHealthyShutdownScenario() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-supervisor-healthy-"));
  const gateway = path.join(workspace, "gateway.mjs");
  fs.writeFileSync(
    gateway,
    'import http from "node:http"; const server=http.createServer((req,res)=>{if(req.url==="/gateway/health"){res.writeHead(200,{"content-type":"application/json"});res.end("{\\"ok\\":true}");}else{res.writeHead(404);res.end();}}); server.listen(Number(process.env.GATEWAY_PORT),"127.0.0.1");',
  );
  const child = spawnSupervisor(workspace, gateway, 18_891);
  const statePath = path.join(workspace, "data", "24-7-supervisor.json");
  try {
    await waitFor(() => readState(statePath)?.status === "running");
    child.kill("SIGTERM");
    const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    if (exitCode !== 0) throw new Error(`healthy shutdown exited with ${exitCode}`);
    if (readState(statePath)?.status !== "stopped")
      throw new Error("healthy shutdown did not persist stopped state");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function runCrashLimitScenario() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-supervisor-crash-"));
  const gateway = path.join(workspace, "gateway.mjs");
  fs.writeFileSync(gateway, "process.exit(2);\n");
  const child = spawnSupervisor(workspace, gateway, 18_892, { MIKI_24_7_MAX_RESTARTS: "1" });
  const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const statePath = path.join(workspace, "data", "24-7-supervisor.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.rmSync(workspace, { recursive: true, force: true });
  if (exitCode === 0 || state.status !== "failed")
    throw new Error(`crash limit scenario did not fail safely: exit=${exitCode}, status=${state.status}`);
}

await runHealthyShutdownScenario();
await runCrashLimitScenario();
console.log("[miki-24-7] integration scenarios passed");
