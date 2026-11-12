#!/usr/bin/env node
/**
 * Authenticated HTTP E2E for a staging Gateway or an isolated local Gateway.
 * UI automation is provided by the Miki Browser Agent extension, not by a
 * bundled automation framework. This script verifies Gateway/API contracts.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const autostart = process.argv.includes("--autostart") || process.env.MIKI_E2E_AUTOSTART === "true";
const suppliedBase = String(process.env.MIKI_E2E_BASE_URL || "").replace(/\/$/, "");
const password = process.env.MIKI_E2E_PASSWORD || (autostart ? randomBytes(32).toString("base64url") : "");
const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, status: ok ? "pass" : "fail" });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
};
const skip = (name, detail = "") => {
  results.push({ name, status: "skip" });
  process.stdout.write(`SKIP ${name}${detail ? ` — ${detail}` : ""}\n`);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_port_unavailable");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function startIsolatedGateway() {
  const projectRoot = process.cwd();
  const entry = path.join(projectRoot, "packages/gateway/dist/index.js");
  const dashboard = path.join(projectRoot, "packages/ui/frontend/dist/index.html");
  if (!existsSync(entry) || !existsSync(dashboard)) throw new Error("build_gateway_and_frontend_before_local_e2e");
  const root = mkdtempSync(path.join(os.tmpdir(), "miki-live-e2e-"));
  const dataDir = path.join(root, "data");
  const workspaceDir = path.join(root, "workspace");
  const configDir = path.join(root, "config");
  for (const dir of [dataDir, workspaceDir, configDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const restartFile = path.join(root, "gateway.restart");
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin", HOME: root, TMPDIR: root,
    LANG: process.env.LANG || "C.UTF-8", NODE_ENV: "production",
    GATEWAY_HOST: "127.0.0.1", GATEWAY_PORT: String(port),
    MIKI_DATA_DIR: dataDir, MIKI_WORKSPACE_DIR: workspaceDir, MIKI_CONFIG_DIR: configDir,
    MIKI_GATEWAY_RESTART_FILE: restartFile, MIKI_BROWSER_BRIDGE_PORT: "0",
    MIKI_MONITOR_RETENTION_DAYS: "30", MIKI_MONITOR_MAX_RUNS_PER_SESSION: "20",
  };
  let stopping = false;
  let activeChild;
  let supervisorError;
  const supervisor = (async () => {
    while (!stopping) {
      try { unlinkSync(restartFile); } catch {}
      const child = spawn(process.execPath, [entry], { cwd: projectRoot, env, stdio: "ignore", windowsHide: true });
      activeChild = child;
      const exit = await new Promise((resolve) => {
        child.once("error", () => resolve({ code: -1 }));
        child.once("exit", (code) => resolve({ code: code ?? -1 }));
      });
      if (stopping) break;
      if (existsSync(restartFile)) continue;
      supervisorError = new Error(`gateway_unexpected_exit_${exit.code}`);
      break;
    }
  })();
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline && !stopping) {
    if (supervisorError) throw supervisorError;
    try { const response = await fetch(`${base}/api/auth/status`, { signal: AbortSignal.timeout(2_000) }); if (response.ok) { ready = true; break; } }
    catch { /* Gateway has not bound its local port yet. */ }
    await wait(250);
  }
  if (!ready) {
    stopping = true;
    activeChild?.kill("SIGTERM");
    await supervisor.catch(() => {});
    rmSync(root, { recursive: true, force: true });
    throw new Error("isolated_gateway_start_timeout");
  }
  return {
    base, root,
    async stop() {
      stopping = true;
      try { unlinkSync(restartFile); } catch {}
      if (activeChild && activeChild.exitCode === null) activeChild.kill("SIGTERM");
      await Promise.race([supervisor.catch(() => {}), wait(5_000)]);
      if (activeChild && activeChild.exitCode === null) activeChild.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let isolated;
let cookie = "";
const api = async (base, route, options = {}, authenticated = true) => fetch(new URL(route, base), {
  ...options,
  headers: { ...(options.headers || {}), ...(authenticated && cookie ? { cookie } : {}) },
});
const captureCookie = (response) => {
  const values = response.headers.getSetCookie?.() || [response.headers.get("set-cookie") || ""];
  const pair = values.find((value) => /miki_session=/.test(value)) || "";
  if (pair) cookie = pair.split(";")[0];
};

try {
  if (!password) throw new Error("Set MIKI_E2E_PASSWORD, or use --autostart for a disposable Gateway.");
  if (autostart && suppliedBase) throw new Error("Do not combine --autostart with MIKI_E2E_BASE_URL.");
  if (!autostart && (!suppliedBase || !/^https?:\/\//i.test(suppliedBase))) throw new Error("Set MIKI_E2E_BASE_URL and MIKI_E2E_PASSWORD, or use npm run test:e2e:local.");
  if (autostart) {
    isolated = await startIsolatedGateway();
    record("isolated-gateway-startup", true, "fresh temporary data/workspace/config roots");
  }
  const base = autostart ? isolated.base : suppliedBase;
  const initial = await api(base, "/api/auth/status", {}, false);
  const initialBody = await initial.json().catch(() => ({}));
  if (!initial.ok) throw new Error("auth_status_unavailable");
  if (initialBody.initialized === false) {
    const setup = await api(base, "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password, confirm: password }) }, false);
    captureCookie(setup);
    record("first-run-auth-setup", setup.ok, `HTTP ${setup.status}`);
    if (!setup.ok) throw new Error("authenticated_setup_failed");
  }
  const login = await api(base, "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }, false);
  captureCookie(login);
  const loginBody = await login.json().catch(() => ({}));
  record("authenticated-login", login.ok && loginBody.ok === true && Boolean(cookie), `HTTP ${login.status}`);
  if (!login.ok || !cookie) throw new Error("authenticated_login_failed");

  const status = await api(base, "/api/auth/status");
  const statusBody = await status.json().catch(() => ({}));
  record("auth-session-status", status.ok && statusBody.authenticated === true, `HTTP ${status.status}`);
  const anonymous = await api(base, "/api/plugins/installed", {}, false);
  record("protected-api-rejects-anonymous-session", anonymous.status === 401, `HTTP ${anonymous.status}`);

  for (const [name, route] of [
    ["monitor-history-api", "/api/monitor/history?limit=1"],
    ["installed-plugins-api", "/api/plugins/installed"],
    ["trusted-plugin-marketplace-api", "/api/plugins/marketplace"],
    ["gateway-status-api", "/api/gateway/status"],
  ]) {
    const response = await api(base, route);
    record(name, response.status === 200, `HTTP ${response.status}`);
  }

  const bridge = await api(base, "/api/browser/bridge");
  const bridgeBody = await bridge.json().catch(() => ({}));
  record("browser-bridge-pairing-info", bridge.ok && bridgeBody.protocol === "miki.browser.v1" && /^ws:\/\/127\.0\.0\.1:\d+\/miki-browser$/.test(bridgeBody.wsUrl || "") && /^[a-f0-9]{64}$/i.test(bridgeBody.token || ""), `HTTP ${bridge.status}`);
  const targets = bridgeBody.installTargets || {};
  const extensionTargetsReady = ["chrome", "firefox", "safari"].every((name) => {
    const target = targets[name];
    return typeof target === "string" && existsSync(path.join(target, "manifest.json")) && existsSync(path.join(target, "service-worker.js")) && existsSync(path.join(target, "content.js"));
  });
  record("browser-extension-manifests", extensionTargetsReady, extensionTargetsReady ? "built Chrome, Firefox and Safari targets" : "run the core build to package extension targets");

  const dashboard = await api(base, "/", {}, false);
  record("dashboard-serves", dashboard.ok && (dashboard.headers.get("content-type") || "").includes("text/html"), `HTTP ${dashboard.status}`);
  if (cookie) {
    await api(base, "/api/auth/logout", { method: "POST" });
    const loggedOut = await api(base, "/api/auth/status", {}, false);
    const loggedOutBody = await loggedOut.json().catch(() => ({}));
    record("logout-invalidates-session", loggedOut.ok && loggedOutBody.authenticated === false, `HTTP ${loggedOut.status}`);
  }
  skip("browser-ui-e2e", "requires a real user browser with the Miki extension installed and paired");
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_error";
  record("live-e2e-run", false, message.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]"));
} finally {
  await isolated?.stop().catch(() => {});
}
const failed = results.filter((item) => item.status === "fail");
const skipped = results.filter((item) => item.status === "skip");
const passed = results.filter((item) => item.status === "pass");
process.stdout.write(`\n${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed (${results.length} total).\n`);
if (failed.length) process.exitCode = 1;
