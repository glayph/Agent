#!/usr/bin/env node
/**
 * build-release-artifacts.mjs
 *
 * Full build pipeline for Miki:
 *   1. TypeScript compilation (tsc -b with project references)
 *   2. Go backend (ui/backend) + CLI (Miki-cli) binaries
 *   3. React frontend (Vite via pnpm)
 *   4. Runtime package assembly (prepare-runtime-package.mjs)
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

function log(msg) {
  console.log(`\x1b[36m[build]\x1b[0m ${msg}`);
}

function fatal(msg) {
  console.error(`\x1b[31m[build] FATAL:\x1b[0m ${msg}`);
  process.exit(1);
}

function run(cmd, cmdArgs, opts = {}) {
  const formattedArgs = process.platform === "win32"
    ? cmdArgs.map((a) => (a.includes(" ") && !a.startsWith('"') ? `"${a}"` : a))
    : cmdArgs;
  log(`Running: ${cmd} ${formattedArgs.join(" ")}`);
  const result = spawnSync(cmd, formattedArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (result.status !== 0) {
    fatal(`${cmd} failed with exit code ${result.status ?? 1}`);
  }
}

function npmCommand() {
  return { command: "npm", args: [] };
}

// ── Step 1: TypeScript compilation ─────────────────────────────────────────────
function buildTypeScript() {
  log("Building TypeScript packages (tsc -b)...");
  run("npx", ["tsc", "-b", "--force"], { cwd: root });
  log("TypeScript build complete");
}

// ── Step 2: Go binaries ────────────────────────────────────────────────────────
function buildGoBackend() {
  const backendDir = path.join(root, "packages", "ui", "backend");
  const outDir = path.join(backendDir, "dist", "bin");
  const exe = process.platform === "win32" ? "Miki-web.exe" : "Miki-web";

  fs.mkdirSync(outDir, { recursive: true });

  log("Building Go backend (Miki-web)...");
  const result = spawnSync(
    "go",
    ["build", "-trimpath", "-ldflags", "-s -w", "-o", path.join(outDir, exe), "."],
    { cwd: backendDir, stdio: "inherit", shell: false }
  );

  if (result.error && result.error.code === "ENOENT") {
    log("WARNING: Go not installed — skipping Miki-web build");
    return;
  }
  if (result.status !== 0) {
    log("WARNING: Miki-web build failed — continuing without it");
    return;
  }
  log(`Built ${exe}`);
}

function buildGoCli() {
  const cliDir = path.join(root, "packages", "cli");
  const outDir = path.join(cliDir, "dist", "bin");
  const exe = process.platform === "win32" ? "Miki-cli.exe" : "Miki-cli";

  fs.mkdirSync(outDir, { recursive: true });

  log("Building Go CLI (Miki-cli)...");
  const result = spawnSync(
    "go",
    ["build", "-trimpath", "-ldflags", "-s -w", "-o", path.join(outDir, exe), "."],
    { cwd: cliDir, stdio: "inherit", shell: false }
  );

  if (result.error && result.error.code === "ENOENT") {
    log("WARNING: Go not installed — skipping Miki-cli build");
    return;
  }
  if (result.status !== 0) {
    log("WARNING: Miki-cli build failed — continuing without it");
    return;
  }
  log(`Built ${exe}`);
}

// ── Step 3: React frontend ─────────────────────────────────────────────────────
function buildFrontend() {
  const frontendDir = path.join(root, "packages", "ui", "frontend");
  log("Building React frontend...");
  run("npm", ["run", "build"], { cwd: frontendDir });
  log("Frontend build complete");
}

// ── Step 4: Runtime package ────────────────────────────────────────────────────
function prepareRuntime() {
  log("Preparing runtime package...");
  run("node", [path.join(root, "scripts", "prepare-runtime-package.mjs")], {
    cwd: root,
  });
  log("Runtime package ready");
}

// ── Main ───────────────────────────────────────────────────────────────────────
function main() {
  const startTime = Date.now();
  log("Starting full build for Miki...");

  buildTypeScript();
  buildGoBackend();
  buildGoCli();
  buildFrontend();
  prepareRuntime();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log("");
  log("=========================================");
  log(`  Build complete! (${elapsed}s)`);
  log("  Runtime: dist/runtime/");
  log("  Ready for distribution");
  log("=========================================");
}

main();
