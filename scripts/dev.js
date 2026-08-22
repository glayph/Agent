#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let child;
let shuttingDown = false;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const task = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false,
    });
    task.once("error", reject);
    task.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal ?? "unknown"}`));
    });
  });
}

async function main() {
  console.log("[miki] Building Agent Miki and the vendored headless llama.cpp runtime...");
  await run(npm, ["run", "build:all"]);
  console.log("[miki] Build complete. Starting the integrated Agent Miki runtime...");
  child = spawn(npm, ["start"], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
    env: process.env,
  });
  child.once("error", (error) => {
    if (!shuttingDown) {
      console.error(`[miki] start failed: ${error.message}`);
      process.exitCode = 1;
    }
  });
  child.once("exit", (code, signal) => {
    child = undefined;
    if (!shuttingDown && signal) process.exitCode = 1;
    else if (!shuttingDown) process.exitCode = code ?? 0;
  });
}

function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child?.pid) child.kill(signal);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

main().catch((error) => {
  console.error(`[miki] dev failed: ${error.message}`);
  process.exit(1);
});
