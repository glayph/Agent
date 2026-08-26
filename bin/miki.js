#!/usr/bin/env node
import { spawn, spawnSync, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CLI_EXE = process.platform === "win32" ? "miki-cli.exe" : "miki-cli";

const requiredRuntimeFiles = [
  ["gateway", "packages/gateway/dist/index.js"],
  ["core API", "packages/core/dist/api/index.js"],
  ["config", "packages/config/dist/index.js"],
  ["installer", "packages/installer/dist/index.js"],
  ["skills", "packages/skills/dist/index.js"],
  ["dashboard", "packages/ui/frontend/dist/index.html"],
];

let runtimeRoot = resolveRuntimeRoot();
let child = null;
let memoryChild = null;
let ownsMemoryChild = false;
let shuttingDown = false;

function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readPackage() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
  } catch {
    return {};
  }
}

function resolveRuntimeRoot() {
  if (process.env.MIKI_RUNTIME_ROOT) {
    return path.resolve(process.env.MIKI_RUNTIME_ROOT);
  }
  // Fall back to legacy env var for backward compatibility during transition
  if (process.env.Miki_RUNTIME_ROOT) {
    return path.resolve(process.env.Miki_RUNTIME_ROOT);
  }
  const packagedCli = path.join(PROJECT_ROOT, "dist", "runtime", "bin", CLI_EXE);
  return exists(packagedCli) ? path.join(PROJECT_ROOT, "dist", "runtime") : PROJECT_ROOT;
}

function runtimePath(relativePath) {
  return path.join(runtimeRoot, relativePath);
}

function cliPath() {
  if (runtimeRoot !== PROJECT_ROOT) {
    const packaged = runtimePath(path.join("bin", CLI_EXE));
    if (exists(packaged)) return packaged;
    // Go CLI is optional. Relocated Node distributions can use the
    // repository's Node CLI entrypoint until the native CLI is built.
    const nodeCli = runtimePath(path.join("packages", "cli", "agent.js"));
    if (exists(nodeCli)) return nodeCli;
    return packaged;
  }
  const compiled = path.join(PROJECT_ROOT, "packages", "cli", "dist", "bin", CLI_EXE);
  if (exists(compiled)) return compiled;
  // The repository ships a Node CLI source entrypoint; use it directly when
  // the optional Go CLI artifact has not been built.
  return path.join(PROJECT_ROOT, "packages", "cli", "agent.js");
}

function missingRuntimeFiles() {
  const missing = requiredRuntimeFiles.filter(([, file]) => !exists(runtimePath(file)));
  if (!exists(cliPath())) missing.push(["cli", cliPath()]);
  return missing;
}

function ensureRuntime() {
  const missing = missingRuntimeFiles();
  if (missing.length === 0) return;

  if (runtimeRoot !== PROJECT_ROOT) {
    fail(
      [
        "Runtime package is incomplete.",
        ...missing.map(([name, file]) => `  missing ${name}: ${runtimePath(file)}`),
      ].join("\n"),
    );
  }

  const onlyCliMissing = missing.length === 1 && missing[0][0] === "cli";
  const script = onlyCliMissing ? "build:cli" : "build";
  const result = spawnSync("npm", ["run", script], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  runtimeRoot = resolveRuntimeRoot();
  const stillMissing = missingRuntimeFiles();
  if (stillMissing.length > 0) {
    fail(
      [
        "Build completed, but required runtime files are still missing.",
        ...stillMissing.map(([name, file]) => `  missing ${name}: ${runtimePath(file)}`),
      ].join("\n"),
    );
  }
}

async function memoryServiceHealthy() {
  const port = Number(process.env.MIKI_MEMORY_PORT || process.env.MEMORY_PORT || 18700);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function start(argv) {
  ensureRuntime();

  const executable = cliPath();
  const nodeCliFallback =
    path.resolve(executable) ===
    path.resolve(PROJECT_ROOT, "packages", "cli", "agent.js");
  const childExecutable = nodeCliFallback ? process.execPath : executable;
  const childArgs = nodeCliFallback ? [executable, ...argv] : argv;
  const env = {
    ...process.env,
    // New canonical env vars
    MIKI_RUNTIME_ROOT: runtimeRoot,
    MIKI_WORKSPACE_DIR: process.env.MIKI_WORKSPACE_DIR || PROJECT_ROOT,
    MIKI_GATEWAY_ENTRY: runtimePath("packages/gateway/dist/index.js"),
    MIKI_RUNTIME_LOADER: runtimePath("runtime-loader.mjs"),
    MIKI_NODE: process.execPath,
    MIKI_PACKAGE_VERSION: readPackage().version || "1.0.0",
    // Keep the inner gateway budget aligned with the outer supervisor unless
    // an explicit inner value was supplied for diagnostics.
    CORE_MAX_RESTARTS:
      process.env.CORE_MAX_RESTARTS ||
      process.env.MIKI_24_7_MAX_RESTARTS ||
      "5",
    ALLOW_UNLIMITED_CORE_RESTARTS:
      process.env.ALLOW_UNLIMITED_CORE_RESTARTS ||
      process.env.MIKI_24_7_ALLOW_UNLIMITED_RESTARTS ||
      "false",
    // Legacy env vars kept during transition
    Miki_RUNTIME_ROOT: runtimeRoot,
    Miki_WORKSPACE_DIR: process.env.MIKI_WORKSPACE_DIR || PROJECT_ROOT,
    Miki_GATEWAY_ENTRY: runtimePath("packages/gateway/dist/index.js"),
    Miki_RUNTIME_LOADER: runtimePath("runtime-loader.mjs"),
    Miki_NODE: process.execPath,
  };

  if (!(await memoryServiceHealthy())) {
    ownsMemoryChild = true;
    memoryChild = fork(
      path.join(PROJECT_ROOT, "packages", "memory", "src", "api", "server.js"),
    );
    memoryChild.once("error", (error) => {
      ownsMemoryChild = false;
      if (error?.code === "EADDRINUSE") {
        console.warn("Miki memory service is already running; reusing the existing listener.");
        return;
      }
      console.error(`Miki memory service failed: ${error.message}`);
    });
  } else {
    console.log("Miki memory service is already healthy; reusing it.");
  }

  if (memoryChild && ownsMemoryChild) {
    memoryChild.once("exit", (code, signal) => {
      memoryChild = null;
      ownsMemoryChild = false;
      if (shuttingDown) return;
      console.error(
        `Miki memory service exited (code=${code}, signal=${signal}); stopping launcher for service-manager recovery.`,
      );
      if (child) terminateChildTree(false);
      process.exit(1);
    });
  }

  child = spawn(childExecutable, childArgs, {
    cwd: PROJECT_ROOT,
    env,
    stdio: "inherit",
    shell: false,
  });

  child.on("error", (err) => fail(`Failed to start Miki: ${err.message}`));
  child.on("exit", (code, signal) => {
    child = null;
    if (memoryChild && ownsMemoryChild) {
      memoryChild.kill("SIGTERM");
      memoryChild = null;
      ownsMemoryChild = false;
    }
    if (shuttingDown) process.exit(0);
    if (signal) {
      console.error(`Miki stopped by ${signal}.`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
}

function stop() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (memoryChild && ownsMemoryChild) memoryChild.kill();
  if (child) {
    terminateChildTree(false);
    setTimeout(() => {
      if (child) terminateChildTree(true);
      process.exit(0);
    }, 9000).unref();
    return;
  }
  process.exit(0);
}

function descendantPids(rootPid) {
  const descendants = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parentPid = pending.shift();
    try {
      const output = spawnSync("pgrep", ["-P", String(parentPid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (output.status !== 0) continue;
      const children = String(output.stdout || "")
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
      descendants.push(...children);
      pending.push(...children);
    } catch {
      // Minimal Windows/Linux installations may not provide pgrep; the direct
      // child is still terminated below, and Windows uses taskkill /T.
    }
  }
  return descendants.reverse();
}

function terminateChildTree(force) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync(
      "taskkill",
      ["/T", ...(force ? ["/F"] : []), "/PID", String(child.pid)],
      { stdio: "ignore", shell: false },
    );
    return;
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  for (const pid of descendantPids(child.pid)) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function fail(message) {
  console.error(`Miki: ${message}`);
  process.exit(1);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const argv = process.argv.slice(2);

// Delegate setup/config commands to the config launcher
if (argv[0] === "setup" || argv[0] === "config") {
  const result = spawnSync(process.execPath, [
    path.join(PROJECT_ROOT, "bin", "miki-config.js"),
    ...argv,
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      MIKI_WORKSPACE_DIR: process.env.MIKI_WORKSPACE_DIR || PROJECT_ROOT,
      Miki_WORKSPACE_DIR: process.env.MIKI_WORKSPACE_DIR || PROJECT_ROOT,
    },
    stdio: "inherit",
    shell: false,
  });
  process.exit(result.status ?? 1);
}

// Delegate doctor command to the doctor script
if (argv[0] === "doctor") {
  const result = spawnSync(process.execPath, [
    path.join(PROJECT_ROOT, "bin", "miki-doctor.mjs"),
    ...argv.slice(1),
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      MIKI_WORKSPACE_DIR: process.env.MIKI_WORKSPACE_DIR || PROJECT_ROOT,
      Miki_WORKSPACE_DIR: process.env.MIKI_WORKSPACE_DIR || PROJECT_ROOT,
    },
    stdio: "inherit",
    shell: false,
  });
  process.exit(result.status ?? 1);
}

void start(argv).catch((error) => fail(error instanceof Error ? error.message : String(error)));
