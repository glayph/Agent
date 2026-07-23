#!/usr/bin/env node
/**
 * build-release-artifacts.mjs
 *
 * Full build pipeline for Hiro:
 *   1. TypeScript compilation (tsc -b with project references)
 *   2. Go backend (ui/backend) + CLI (Hiro-cli) binaries
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
  log(`Running: ${cmd} ${cmdArgs.join(" ")}`);
  const result = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    shell: false,
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
  const exe = "Hiro-web";

  fs.mkdirSync(outDir, { recursive: true });

  log("Building Go backend (Hiro-web)...");
  const result = spawnSync(
    "go",
    ["build", "-trimpath", "-ldflags", "-s -w", "-o", path.join(outDir, exe), "."],
    { cwd: backendDir, stdio: "inherit", shell: false }
  );

  if (result.error && result.error.code === "ENOENT") {
    log("WARNING: Go not installed — skipping Hiro-web build");
    return;
  }
  if (result.status !== 0) {
    log("WARNING: Hiro-web build failed — continuing without it");
    return;
  }
  log(`Built ${exe}`);
}

function buildGoCli() {
  const cliDir = path.join(root, "packages", "cli");
  const outDir = path.join(cliDir, "dist", "bin");
  const exe = "Hiro-cli";

  fs.mkdirSync(outDir, { recursive: true });

  log("Building Go CLI (Hiro-cli)...");
  const result = spawnSync(
    "go",
    ["build", "-trimpath", "-ldflags", "-s -w", "-o", path.join(outDir, exe), "."],
    { cwd: cliDir, stdio: "inherit", shell: false }
  );

  if (result.error && result.error.code === "ENOENT") {
    log("WARNING: Go not installed — skipping Hiro-cli build");
    return;
  }
  if (result.status !== 0) {
    log("WARNING: Hiro-cli build failed — continuing without it");
    return;
  }
  log(`Built ${exe}`);
}

// ── Step 3: React frontend ─────────────────────────────────────────────────────
function buildFrontend() {
  log("Building React frontend (pnpm build)...");
  const frontendDir = path.join(root, "packages", "ui", "frontend");
  const result = spawnSync("node", [
    path.join(root, "scripts", "frontend-pnpm.mjs"),
    "build",
  ], { cwd: root, stdio: "inherit", shell: false });

  if (result.status !== 0) {
    fatal("Frontend build failed");
  }
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
  log("Starting full build for Hiro...");

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
