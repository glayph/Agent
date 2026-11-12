#!/usr/bin/env node
/**
 * Reports what the current host can actually qualify for a Miki release.
 * This is a truthful preflight, not a substitute for target-host GUI tests.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const strict = args.includes("--strict");
const requireComputer = args.includes("--require-computer");
const outputIndex = args.indexOf("--output");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const unknown = args.filter((arg) => arg.startsWith("-") && !["--json", "--strict", "--require-computer", "--output"].includes(arg));
if (unknown.length || (outputIndex >= 0 && !outputPath)) {
  console.error("Usage: node scripts/platform-qualification.mjs [--json] [--strict] [--require-computer] [--output <file>]");
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const requiredNode = String(packageJson.engines?.node ?? ">=22.19.0");
const [major, minor, patch] = process.versions.node.split(".").map(Number);
const nodeSupported = major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)));

function commandExists(command) {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], { encoding: "utf8", stdio: "ignore" });
  return result.status === 0;
}
function item(id, status, detail) { return { id, status, detail }; }
function probeX11Display() {
  // An environment variable alone does not prove that an X server is reachable.
  if (!process.env.DISPLAY) return false;
  if (commandExists("xdpyinfo")) return spawnSync("xdpyinfo", [], { stdio: "ignore" }).status === 0;
  if (commandExists("xset")) return spawnSync("xset", ["q"], { stdio: "ignore" }).status === 0;
  if (commandExists("xdotool")) return spawnSync("xdotool", ["getmouselocation", "--shell"], { stdio: "ignore" }).status === 0;
  return false;
}

const checks = [];
checks.push(item("node-runtime", nodeSupported ? "PASS" : "BLOCKED", `Node ${process.versions.node}; project requires ${requiredNode}.`));
checks.push(item("source-metadata", fs.existsSync(path.join(root, ".git")) ? "PASS" : "PARTIAL", fs.existsSync(path.join(root, ".git")) ? "Git metadata is available." : "Source ZIP has no .git metadata; archive hash must identify this build."));
checks.push(item("workspace-dependencies", fs.existsSync(path.join(root, "node_modules")) ? "PASS" : "BLOCKED", fs.existsSync(path.join(root, "node_modules")) ? "Root node_modules exists; package-level gates still validate actual dependencies." : "node_modules is absent; official lint, Jest, Vitest and workspace builds cannot run."));
for (const [id, relative] of [
  ["eslint", "node_modules/eslint/package.json"],
  ["jest", "node_modules/jest/package.json"],
  ["vitest", "node_modules/vitest/package.json"],
  ["better-sqlite3", "node_modules/better-sqlite3/package.json"],
]) {
  const present = fs.existsSync(path.join(root, relative));
  checks.push(item(id, present ? "PASS" : "BLOCKED", present ? "Project dependency is installed." : `Missing ${relative}.`));
}

let computerStatus = "PARTIAL";
let computerDetail = "No full ComputerAgent target qualification was established.";
if (process.platform === "win32") {
  computerDetail = "Windows is the primary semantic UI Automation target; this preflight does not prove a logged-in interactive desktop or UI Automation provider.";
} else if (process.platform === "linux") {
  const hasDisplay = Boolean(process.env.DISPLAY);
  const displayConnected = probeX11Display();
  const xdotool = commandExists("xdotool");
  const xclip = commandExists("xclip");
  if (displayConnected && xdotool && xclip) {
    computerStatus = "READY_FOR_TARGET_TEST";
    computerDetail = "Linux X11 display and helper prerequisites are present; Miki action and screenshot-to-model tests are still required.";
  } else if (process.env.WAYLAND_DISPLAY && !hasDisplay) {
    const python = commandExists("python3");
    const atspi = python && spawnSync("python3", ["-c", "import pyatspi"], { stdio: "ignore" }).status === 0;
    computerStatus = atspi ? "READY_FOR_TARGET_TEST" : "PARTIAL";
    computerDetail = atspi
      ? "Wayland session has AT-SPI bindings for semantic application controls; X11 coordinate input/screenshots are unavailable without XWayland. Live application tests are still required."
      : "Wayland-only session can use semantic controls after python3-pyatspi and at-spi2-core are installed; coordinate input and screenshots need a supported XWayland/session backend.";
  } else {
    computerDetail = `Linux X11 prerequisites incomplete (DISPLAY=${hasDisplay ? "set" : "unset"}, X11 probe=${displayConnected ? "connected" : "unavailable"}, xdotool=${xdotool}, xclip=${xclip}). AT-SPI semantic controls may still work when the accessibility bus is available.`;
  }
} else if (process.platform === "darwin") {
  computerStatus = "READY_FOR_TARGET_TEST";
  computerDetail = "The source includes a macOS System Events Accessibility backend; target tests still require Accessibility permission and, for screenshots, Screen Recording permission.";
} else {
  computerStatus = "UNSUPPORTED";
  computerDetail = `No ComputerAgent capability matrix is declared for ${process.platform}.`;
}
checks.push(item("computer-platform", computerStatus, computerDetail));

const report = {
  generatedAt: new Date().toISOString(),
  version: packageJson.version,
  platform: process.platform,
  architecture: process.arch,
  node: process.versions.node,
  requiredNode,
  checks,
  summary: {
    pass: checks.filter((check) => check.status === "PASS").length,
    partial: checks.filter((check) => check.status === "PARTIAL" || check.status === "READY_FOR_TARGET_TEST").length,
    blocked: checks.filter((check) => check.status === "BLOCKED" || check.status === "UNSUPPORTED").length,
  },
};

if (outputPath) fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`MIKI PLATFORM QUALIFICATION — ${report.platform}/${report.architecture} — Node ${report.node}`);
  for (const check of checks) console.log(`[${check.status}] ${check.id}: ${check.detail}`);
  console.log(`Summary: ${report.summary.pass} PASS, ${report.summary.partial} PARTIAL, ${report.summary.blocked} BLOCKED/UNSUPPORTED`);
}

const requiredChecks = checks.filter((check) => [
  "node-runtime", "workspace-dependencies", "eslint", "jest", "vitest", "better-sqlite3",
].includes(check.id));
const failedRequired = requiredChecks.some((check) => check.status !== "PASS");
const failedComputer = requireComputer && !["PASS", "READY_FOR_TARGET_TEST"].includes(computerStatus);
if ((strict && failedRequired) || failedComputer) process.exit(2);
