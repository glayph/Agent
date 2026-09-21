#!/usr/bin/env node
/**
 * Agent Miki package installation feedback.
 *
 * npm runs this after the package has been unpacked. It deliberately does not
 * install anything or contact the network: it only verifies the bundled
 * runtime and reports the initialization stages.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isTTY = Boolean(process.stdout.isTTY && process.env.CI !== "true");
const canUnicode = process.env.TERM !== "dumb" && process.env.NO_COLOR !== "1";
const BAR_WIDTH = 24;

const requiredFiles = [
  ["CLI launcher", path.join("dist", "pack", "bin", "miki.js")],
  [
    "gateway runtime",
    path.join("dist", "pack", "packages", "gateway", "dist", "index.js"),
  ],
];

function drawBar(percent) {
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  if (canUnicode) return `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
  return `${"#".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}`;
}

function render(stage, percent, detail = "") {
  const line = `Agent Miki  [${drawBar(percent)}] ${String(percent).padStart(3, " ")}%  ${stage}${detail ? ` — ${detail}` : ""}`;
  if (isTTY) {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(line);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

function finish(ok, message) {
  if (isTTY) process.stdout.write("\n");
  process.stdout.write(`${ok ? "✓" : "!"} Agent Miki ${message}\n`);
}

function checkRequiredFiles() {
  for (const [label, relative] of requiredFiles) {
    const target = path.join(packageRoot, relative);
    if (!fs.existsSync(target)) {
      throw new Error(`${label} is missing: ${relative}`);
    }
  }
}

function nextFrame() {
  // A short frame lets a human see each stage without making npm install slow.
  // CI/non-TTY output remains immediate and deterministic.
  return isTTY ? new Promise((resolve) => setTimeout(resolve, 40)) : Promise.resolve();
}

async function main() {
  // Respect npm's quiet/loglevel flags and explicit opt-out for scripts.
  if (process.env.MIKI_INSTALL_TUI === "0" || process.env.npm_config_loglevel === "silent") return;

  try {
    render("Preparing installation", 12, "package unpacked");
    await nextFrame();
    render("Checking bundled runtime", 48);
    checkRequiredFiles();
    await nextFrame();
    render("Registering Agent Miki package", 78, "no network access");
    await nextFrame();
    render("Initializing Agent Miki", 100);
    finish(true, "ready — run `miki` to start");
  } catch (error) {
    if (isTTY) process.stdout.write("\n");
    finish(false, `installation check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await main();
