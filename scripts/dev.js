#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { seedWorkspaceConfig } from "./workspace-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let child;
let shuttingDown = false;
let supervisorRestartTimer;
let supervisorRestartCount = 0;

function resolveWorkspaceRoot() {
  return path.resolve(process.env.MIKI_WORKSPACE_DIR || root);
}

function resolveDataRoot() {
  return path.resolve(process.env.MIKI_DATA_DIR || path.join(resolveWorkspaceRoot(), "data"));
}

function loadDotEnvFiles() {
  for (const relativePath of [".env", "config/.env"]) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) continue;
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!value || process.env[key] !== undefined) continue;
      process.env[key] = value;
    }
  }
}

function seedRuntimeConfig() {
  const configDir = path.resolve(process.env.MIKI_CONFIG_DIR || path.join(resolveWorkspaceRoot(), "config"));
  const seeded = seedWorkspaceConfig(root, configDir);
  if (seeded.length > 0) console.log(`[miki] Seeded missing workspace config: ${seeded.join(", ")}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const task = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    task.once("error", reject);
    task.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal ?? "unknown"}`));
    });
  });
}

async function main() {
  loadDotEnvFiles();
  seedRuntimeConfig();
  // Match the regular CLI launch defaults before entering the supervised runtime.
  if (process.env.MIKI_ALLOW_REMOTE_SETUP === undefined) process.env.MIKI_ALLOW_REMOTE_SETUP = "1";
  process.env.GATEWAY_HOST ||= "0.0.0.0";

  console.log("[miki] Building Agent Miki and the vendored headless llama.cpp runtime...");
  await run(npm, ["run", "build:all"]);
  if (shuttingDown) return;

  console.log("[miki] Build complete. Starting Miki under its 24/7 self-healing supervisor...");
  launchSupervisor();
}


function launchSupervisor() {
  if (shuttingDown) return;
  const startedAt = Date.now();
  const workspaceRoot = resolveWorkspaceRoot();
  const dataRoot = resolveDataRoot();
  const supervisorPath = path.join(root, "scripts", "miki-24-7.mjs");
  const launched = spawn(process.execPath, [supervisorPath], {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      MIKI_SOURCE_ROOT: process.env.MIKI_SOURCE_ROOT || root,
      MIKI_WORKSPACE_DIR: workspaceRoot,
      MIKI_RUNTIME_ROOT: process.env.MIKI_RUNTIME_ROOT || workspaceRoot,
      MIKI_CONFIG_DIR: process.env.MIKI_CONFIG_DIR || path.join(workspaceRoot, "config"),
      MIKI_DATA_DIR: dataRoot,
    },
  });
  child = launched;
  launched.once("error", (error) => {
    console.error(`[miki] supervisor process error: ${error.message}`);
  });
  launched.once("exit", (code, signal) => {
    if (child === launched) child = undefined;
    if (shuttingDown) return;
    // The dashboard can request an orderly service shutdown by asking the Gateway
    // to create the supervisor stop-request file. Respect that owner action rather
    // than treating it as a crash and immediately relaunching the service.
    try {
      const statePath = path.join(dataRoot, "24-7-supervisor.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (state?.status === "stopped" && state?.shutdownRequested === true) {
        console.log("[miki] Runtime shutdown was explicitly requested; leaving the supervisor stopped.");
        return;
      }
    } catch {
      // Missing/stale state is not proof of an intentional shutdown; recover below.
    }
    const livedMs = Date.now() - startedAt;
    if (livedMs >= 5 * 60_000) supervisorRestartCount = 0;
    supervisorRestartCount += 1;
    const delayMs = Math.min(3 * 60_000, 1_000 * (2 ** Math.min(supervisorRestartCount - 1, 8)));
    console.error(`[miki] 24/7 supervisor exited (code=${code ?? "none"}, signal=${signal ?? "none"}); restarting in ${Math.ceil(delayMs / 1000)}s.`);
    supervisorRestartTimer = setTimeout(() => {
      supervisorRestartTimer = undefined;
      launchSupervisor();
    }, delayMs);
  });
}

function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (supervisorRestartTimer) clearTimeout(supervisorRestartTimer);
  supervisorRestartTimer = undefined;
  if (child?.pid) child.kill(signal);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

main().catch((error) => {
  console.error(`[miki] dev failed: ${error.message}`);
  process.exit(1);
});
