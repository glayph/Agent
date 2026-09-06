import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";
const cmake = isWindows ? "cmake.exe" : "cmake";
const args = new Set(process.argv.slice(2));
const skipInstall = args.has("--skip-install");
const skipVerify = args.has("--skip-verify");
const release = args.has("--release");
const ci = args.has("--ci");

function log(message) {
  console.log(`[miki:build-local] ${message}`);
}
function fail(message) {
  console.error(`[miki:build-local] ERROR: ${message}`);
  process.exit(1);
}
function run(command, commandArgs, options = {}) {
  log(`${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell: isWindows && command.toLowerCase().endsWith(".cmd"),
    ...options,
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with status ${result.status ?? "unknown"}`);
}
function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: isWindows && command.toLowerCase().endsWith(".cmd"),
  });
  return result.status === 0;
}
function checkPrerequisites() {
  if (!commandAvailable(npm)) fail(`${npm} is required. Install Node.js 20 or newer and npm.`);
  if (!commandAvailable(cmake)) {
    fail(`${cmake} is required for the native llama.cpp runtime. Install CMake and a C/C++ compiler, then rerun this command.`);
  }
  if (!isWindows && !commandAvailable("c++") && !commandAvailable("g++") && !commandAvailable("clang++")) {
    fail("A C++ compiler is required on Linux. Install build-essential or an equivalent compiler toolchain.");
  }
  if (isWindows && !process.env.VCINSTALLDIR && !process.env.VisualStudioVersion) {
    log("MSVC environment was not detected in this shell; CMake may still locate an installed Visual Studio toolchain.");
  }
}
function packageJson() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}
function main() {
  const manifest = packageJson();
  log(`Starting reproducible ${process.platform}-${process.arch} build for Agent Miki ${manifest.version}.`);
  checkPrerequisites();
  if (!skipInstall) {
    run(npm, ["ci", "--ignore-scripts"], { env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" } });
    run(npm, ["rebuild", "better-sqlite3"]);
  }
  const jobs = process.env.MIKI_LLAMA_BUILD_JOBS || String(Math.max(1, Math.min(2, os.cpus().length)));
  run(npm, ["run", "build:all"], {
    env: { ...process.env, MIKI_LLAMA_BUILD_JOBS: jobs, ...(ci ? { CI: "true" } : {}) },
  });
  if (!skipVerify) run(npm, ["run", "verify"]);
  if (release) {
    const releaseScript = isWindows ? "build:release:windows" : "build:release:linux";
    run(npm, ["run", releaseScript]);
  }
  log(`PASS local ${process.platform}-${process.arch} build completed${release ? " with offline release packaging" : ""}.`);
}
main();
