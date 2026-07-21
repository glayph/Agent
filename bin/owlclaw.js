#!/usr/bin/env node
import { spawn, spawnSync, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CLI_EXE = "Hiro-cli";

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
  if (process.env.Hiro_RUNTIME_ROOT) {
    return path.resolve(process.env.Hiro_RUNTIME_ROOT);
  }
  const packagedCli = path.join(PROJECT_ROOT, "dist", "runtime", "bin", CLI_EXE);
  return exists(packagedCli) ? path.join(PROJECT_ROOT, "dist", "runtime") : PROJECT_ROOT;
}

function runtimePath(relativePath) {
  return path.join(runtimeRoot, relativePath);
}

function cliPath() {
  return runtimeRoot === PROJECT_ROOT
    ? path.join(PROJECT_ROOT, "packages", "Hiro-cli", "dist", "bin", CLI_EXE)
    : runtimePath(path.join("bin", CLI_EXE));
}

function npmCommand() {
  return { command: "npm", args: [] };
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
  const npm = npmCommand();
  const result = spawnSync(npm.command, [...npm.args, "run", script], {
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
    Hiro_RUNTIME_ROOT: runtimeRoot,
    Hiro_WORKSPACE_DIR: process.env.Hiro_WORKSPACE_DIR || PROJECT_ROOT,
    Hiro_GATEWAY_ENTRY: runtimePath("packages/gateway/dist/index.js"),
    Hiro_RUNTIME_LOADER: runtimePath("runtime-loader.mjs"),
    Hiro_NODE: process.execPath,
    Hiro_PACKAGE_VERSION: readPackage().version || "1.0.0",
  };

  memoryChild = fork(path.join(PROJECT_ROOT, "packages", "Hiro-memory", "src", "api", "server.js"));

  child = spawn(executable, argv, {
    cwd: PROJECT_ROOT,
    env,
    stdio: "inherit",
    shell: false,
  });

  child.on("error", (err) => fail(`Failed to start Hiro: ${err.message}`));
  child.on("exit", (code, signal) => {
    child = null;
    if (shuttingDown) process.exit(0);
    if (signal) {
      console.error(`Hiro stopped by ${signal}.`);
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
  console.error(`Hiro: ${message}`);
  process.exit(1);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const argv = process.argv.slice(2);
if (argv[0] === "doctor") {
  const result = spawnSync(process.execPath, [
    path.join(PROJECT_ROOT, "bin", "Hiro-doctor.mjs"),
    ...argv.slice(1),
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      Hiro_WORKSPACE_DIR: process.env.Hiro_WORKSPACE_DIR || PROJECT_ROOT,
    },
    stdio: "inherit",
    shell: false,
  });
  process.exit(result.status ?? 1);
}

start(argv);
