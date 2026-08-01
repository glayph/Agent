#!/usr/bin/env node
/**
 * run-release-verify.mjs
 *
 * Release-grade verification: lint + test + build + pack:check + audit + smoke.
 * Used by `npm run verify:release`.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  console.log(`Usage: node scripts/run-release-verify.mjs [options]

Release-grade verification: lint + test + build + pack:check + audit + smoke.

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
  console.log(`\x1b[36m[verify:release]\x1b[0m ${msg}`);
}

function fatal(msg) {
  console.error(`\x1b[31m[verify:release] FAILED:\x1b[0m ${msg}`);
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
  const startTime = Date.now();
  log("Starting release verification...");

  // Step 1: Lint
  log("Step 1/7: Linting...");
  run("npx", [
    "eslint",
    "packages/**/*.ts",
    "--ignore-pattern",
    "packages/ui/frontend/**",
    "--max-warnings=0",
  ], { cwd: root });

  // Step 2: Tests
  log("Step 2/7: Running tests...");
  run("npx", ["jest", "--runInBand"], { cwd: root });

  // Step 3: Full build
  log("Step 3/7: Building...");
  run("node", [path.join(root, "scripts", "build-release-artifacts.mjs")], {
    cwd: root,
  });

  // Step 4: Pack check
  log("Step 4/7: Checking package contents...");
  const packCheckScript = path.join(root, "scripts", "assert-pack-contents.mjs");
  if (fs.existsSync(packCheckScript)) {
    run("node", [packCheckScript], { cwd: root });
  } else {
    log("Skipping pack:check (script not found)");
  }

  // Step 5: Production audit
  log("Step 5/7: Auditing production dependencies...");
  run("npm", ["audit", "--omit=dev", "--audit-level=moderate"], { cwd: root });

  // Step 6: Gateway smoke test
  log("Step 6/7: Running gateway smoke test...");
  const smokeScript = path.join(root, "scripts", "smoke-gateway-integration.mjs");
  if (fs.existsSync(smokeScript)) {
    run("node", [smokeScript], { cwd: root });
  } else {
    log("Skipping smoke:gateway (script not found)");
  }

  // Step 7: Doctor
  log("Step 7/7: Running doctor checks...");
  run("node", [path.join(root, "bin", "Hiro.js"), "doctor"], { cwd: root });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log("");
  log("=========================================");
  log(`  Release verification passed! (${elapsed}s)`);
  log("  Ready for packaging.");
  log("=========================================");
}

main();
