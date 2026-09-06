#!/usr/bin/env node
/**
 * run-verify.mjs
 *
 * Standard verification: lint + dependency build + typecheck + build + test + doctor.
 * Used by `npm run verify`.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const eslintEntry = path.join(
  root,
  "node_modules",
  "eslint",
  "bin",
  "eslint.js",
);

if (args.includes("-h") || args.includes("--help")) {
  console.log(`Usage: node scripts/run-verify.mjs [options]

Standard verification: lint + dependency build + typecheck + build + test + doctor.

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
  if (result.error) {
    fatal(`${cmd} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fatal(`${cmd} failed with exit code ${result.status ?? 1}`);
  }
}

function runNpm(args, opts = {}) {
  if (process.platform === "win32") {
    run("npm.cmd", args, { ...opts, shell: true });
    return;
  }
  run("npm", args, opts);
}

function main() {
  log("Starting verification...");

  // Step 1: TypeScript lint
  log("Step 1/5: Linting backend packages...");
  run(
    process.execPath,
    [
      eslintEntry,
      "packages/config/src/**/*.ts",
      "packages/core/src/**/*.ts",
      "packages/gateway/src/**/*.ts",
      "packages/installer/src/**/*.ts",
      "packages/memory/src/**/*.ts",
      "packages/skills/src/**/*.ts",
      "--ignore-pattern",
      "packages/core/src/plugins/providers/llama-cpp/runtime/vendor/**",
      "--ignore-pattern",
      "packages/core/src/plugins/providers/llama-cpp/runtime/miki-native-runtime/**",
      "--max-warnings=0",
    ],
    { cwd: root },
  );

  // Step 2: Build workspace dependencies so package exports and declarations
  // exist before strict typechecking on a clean checkout.
  log("Step 2/6: Building workspace dependencies...");
  for (const workspace of ["@miki/config", "@miki/installer", "@miki/skills", "@miki/memory"]) {
    runNpm(["run", "build", "--workspace=" + workspace], { cwd: root });
  }

  // Step 3: Strict typechecking
  log("Step 3/6: Running strict typechecks...");
  runNpm(["run", "typecheck", "--workspaces", "--if-present"], { cwd: root });
  runNpm(
    ["--prefix", path.join(root, "packages", "ui", "frontend"), "run", "build"],
    {
      cwd: root,
    },
  );

  // Step 4: Production builds
  log("Step 4/6: Running production builds...");
  runNpm(["run", "build:all"], { cwd: root });

  // Step 5: Tests
  log("Step 5/6: Running tests...");
  runNpm(["test", "--workspaces", "--if-present"], { cwd: root });
  runNpm(
    ["--prefix", path.join(root, "packages", "ui", "frontend"), "run", "test"],
    {
      cwd: root,
    },
  );

  // Step 6: Doctor checks
  log("Step 6/6: Running doctor checks...");
  run("node", [path.join(root, "bin", "miki.js"), "doctor"], { cwd: root });

  log("");
  log("=========================================");
  log("  All verification checks passed!");
  log("=========================================");
}

main();
