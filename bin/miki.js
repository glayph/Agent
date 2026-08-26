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
    return runtimePath(path.join("bin", CLI_EXE));
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

function start(argv) {
  ensureRuntime();

  const executable = cliPath();
  const env = {
    ...process.env,
    // New canonical env vars
    MIKI_RUNTIME_ROOT: runtimeRoot,
    MIKI_WORKSPACE_DIR: process.env.MIKI_WORKSPACE_DIR || PROJECT_ROOT,
    MIKI_GATEWAY_ENTRY: runtimePath("packages/gateway/dist/index.js"),
    MIKI_RUNTIME_LOADER: runtimePath("runtime-loader.mjs"),
    MIKI_NODE: process.execPath,
    MIKI_PACKAGE_VERSION: readPackage().version || "1.0.0",
    // Legacy env vars kept during transition
    Miki_RUNTIME_ROOT: runtimeRoot,
    Miki_WORKSPACE_DIR: process.env.MIKI_WORKSPACE_DIR || PROJECT_ROOT,
    Miki_GATEWAY_ENTRY: runtimePath("packages/gateway/dist/index.js"),
    Miki_RUNTIME_LOADER: runtimePath("runtime-loader.mjs"),
    Miki_NODE: process.execPath,
  };

  memoryChild = fork(path.join(PROJECT_ROOT, "packages", "memory", "src", "api", "server.js"));

  child = spawn(executable, argv, {
    cwd: PROJECT_ROOT,
    env,
    stdio: "inherit",
    shell: false,
  });

  child.on("error", (err) => fail(`Failed to start Miki: ${err.message}`));
  child.on("exit", (code, signal) => {
    child = null;
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
  if (memoryChild) memoryChild.kill();
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

function terminateChildTree(force) {
  if (!child?.pid) return;
  child.kill(force ? "SIGKILL" : "SIGTERM");
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

start(argv);
