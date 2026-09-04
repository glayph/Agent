import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not allocate a free TCP port");
  return port;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error("launcher did not exit in time")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miki-gateway-smoke-"));
const workspaceDir = path.join(tempRoot, "workspace");
fs.mkdirSync(workspaceDir, { recursive: true });
const [gatewayPort, corePort, memoryPort] = await Promise.all([
  freePort(),
  freePort(),
  freePort(),
]);
const env = {
  ...process.env,
  MIKI_WORKSPACE_DIR: workspaceDir,
  Miki_WORKSPACE_DIR: workspaceDir,
  GATEWAY_HOST: "127.0.0.1",
  GATEWAY_PORT: String(gatewayPort),
  CORE_PORT: String(corePort),
  MEMORY_PORT: String(memoryPort),
  MIKI_MEMORY_PORT: String(memoryPort),
  MIKI_DASHBOARD_PASSWORD: "smoke-test-password",
  MIKI_AUTO_INSTALL_MODEL: "false",
  MIKI_PROVIDER: "llama.cpp",
  MIKI_MODEL: "llama.cpp/local-model",
};

const child = spawn(process.execPath, [path.join(root, "bin", "miki.js"), "start"], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
const collect = (chunk) => {
  output = `${output}${chunk}`.slice(-12_000);
};
child.stdout.on("data", collect);
child.stderr.on("data", collect);

try {
  const healthUrl = `http://127.0.0.1:${gatewayPort}/gateway/health`;
  const dashboardUrl = `http://127.0.0.1:${gatewayPort}/`;
  let health;
  let lastError = "";
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`launcher exited early with code ${child.exitCode}\n${output}`);
    }
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) {
        health = await response.json();
        break;
      }
      lastError = `health returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  if (!health) throw new Error(`gateway health did not become ready: ${lastError}\n${output}`);

  const dashboard = await fetch(dashboardUrl, { signal: AbortSignal.timeout(3_000) });
  if (!dashboard.ok) throw new Error(`dashboard returned HTTP ${dashboard.status}`);
  const html = await dashboard.text();
  if (!html.toLowerCase().includes("agent") && !html.toLowerCase().includes("miki")) {
    throw new Error("dashboard response did not contain an Agent Miki marker");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        gatewayPort,
        corePort,
        memoryPort,
        healthStatus: health.status ?? "ok",
        dashboardStatus: dashboard.status,
      },
      null,
      2,
    ),
  );
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    try {
      await waitForExit(child, 12_000);
    } catch {
      child.kill("SIGKILL");
      await waitForExit(child, 3_000).catch(() => undefined);
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
