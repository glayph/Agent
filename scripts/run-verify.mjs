#!/usr/bin/env node
/**
 * run-verify.mjs
 *
 * Standard verification: lint + test + doctor.
 * Used by `npm run verify`.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  console.log(`Usage: node scripts/run-verify.mjs [options]

Standard verification: lint + test + doctor.

Options:
  -h, --help    Show this help message

No additional flags are accepted. Unknown flags will cause an error.`);
  process.exit(0);
}

const unknownFlags = args.filter((a) => a.startsWith("-"));
if (unknownFlags.length > 0) {
  console.error(`Unknown flag(s): ${unknownFlags.join(", ")}`);
  console.error("Run with --help for usage information.");
  process.exit(1);
}

function log(msg) {
  console.log(`\x1b[36m[verify]\x1b[0m ${msg}`);
}

function fatal(msg) {
  console.error(`\x1b[31m[verify] FAILED:\x1b[0m ${msg}`);
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

function main() {
  log("Starting verification...");

  // Step 1: TypeScript lint
  log("Step 1/3: Linting...");
  run("npx", [
    "eslint",
    "packages/**/*.ts",
    "--ignore-pattern",
    "packages/ui/frontend/**",
    "--max-warnings=0",
  ], { cwd: root });

  // Step 2: Tests
  log("Step 2/3: Running tests...");
  run("npx", ["jest", "--runInBand"], { cwd: root });

  // Step 3: Doctor
  log("Step 3/3: Running doctor checks...");
  run("node", [path.join(root, "bin", "Hiro.js"), "doctor"], { cwd: root });

  log("");
  log("=========================================");
  log("  All verification checks passed!");
  log("=========================================");
}

main();
