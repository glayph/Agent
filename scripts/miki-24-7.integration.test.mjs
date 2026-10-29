#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
  const customDataDir = path.join(workspace, "custom-data");
  const child = spawnSupervisor(workspace, gateway, 18_891, { MIKI_DATA_DIR: customDataDir });
  const statePath = path.join(customDataDir, "24-7-supervisor.json");
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

async function startWebhook() {
  const events = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        events.push(JSON.parse(body).event);
      } catch {
        /* ignore malformed webhook bodies */
      }
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { events, server, url: `http://127.0.0.1:${server.address().port}/hook` };
}

// A gateway that crashes on every start must be restarted without limit. The
// old behaviour (failed state after the restart limit) is gone, and the crash
// notification is still sent for every crash.
async function runUnlimitedRestartScenario() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-supervisor-crash-"));
  const gateway = path.join(workspace, "gateway.mjs");
  fs.writeFileSync(gateway, "process.exit(2);\n");
  const hook = await startWebhook();
  const child = spawnSupervisor(workspace, gateway, 18_892, {
    // Any restart limit set in the environment must be ignored.
    MIKI_24_7_MAX_RESTARTS: "1",
    MIKI_24_7_WEBHOOK_URL: hook.url,
  });
  const statePath = path.join(workspace, "data", "24-7-supervisor.json");
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  try {
    // 1s backoff per restart: well past the old limit of 1 within a few seconds.
    await waitFor(() => (readState(statePath)?.restartCount ?? 0) >= 4, 20_000);
    if (exited) throw new Error("supervisor exited after repeated crashes");
    const state = readState(statePath);
    if (state?.status === "failed")
      throw new Error("supervisor entered failed state after repeated crashes");
    child.kill("SIGTERM");
    const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    if (exitCode !== 0) throw new Error(`shutdown after crashes exited with ${exitCode}`);
    if (hook.events.filter((event) => event === "gateway_crashed").length < 3)
      throw new Error(`gateway_crashed notifications missing: ${hook.events.join(",")}`);
    if (hook.events.includes("restart_exhausted"))
      throw new Error("restart_exhausted must never be sent");
  } finally {
    child.kill("SIGKILL");
    hook.server.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// A gateway that is alive as a process but stops answering (SIGSTOP) must be killed and restarted by the watchdog.
async function runHangWatchdogScenario() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-supervisor-hang-"));
  const gateway = path.join(workspace, "gateway.mjs");
  const pidFile = path.join(workspace, "pids.txt");
  fs.writeFileSync(
    gateway,
    `import http from "node:http"; import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n"); const server=http.createServer((req,res)=>{if(req.url==="/gateway/live"||req.url==="/gateway/health"){res.writeHead(200,{"content-type":"application/json"});res.end("{\\"ok\\":true}");}else{res.writeHead(404);res.end();}}); server.listen(Number(process.env.GATEWAY_PORT),"127.0.0.1");`,
  );
  const child = spawnSupervisor(workspace, gateway, 18_893, {
    MIKI_WATCHDOG_INTERVAL_MS: "1000",
    MIKI_WATCHDOG_TIMEOUT_MS: "1000",
    MIKI_WATCHDOG_FAILURES: "3",
  });
  const statePath = path.join(workspace, "data", "24-7-supervisor.json");
  const pids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean) : []);
  try {
    await waitFor(() => readState(statePath)?.status === "running" && pids().length >= 1, 15_000);
    const first = Number(pids()[0]);
    await wait(1500); // a healthy gateway must NOT be restarted
    if (pids().length !== 1) throw new Error("watchdog restarted a healthy gateway");
    process.kill(first, "SIGSTOP");
    const stoppedAt = Date.now();
    await waitFor(() => pids().length >= 2, 30_000);
    const seconds = (Date.now() - stoppedAt) / 1000;
    if (seconds > 20) throw new Error(`hung gateway restarted too slowly (${seconds}s)`);
    try { process.kill(first, 0); throw new Error("hung gateway process was not killed"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", () => resolve()));
  } finally {
    for (const pid of pids()) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    child.kill("SIGKILL");
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

await runHealthyShutdownScenario();
await runUnlimitedRestartScenario();
await runHangWatchdogScenario();
console.log("[miki-24-7] integration scenarios passed");
