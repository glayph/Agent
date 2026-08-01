#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());

function log(msg) {
  console.log(`[build] ${msg}`);
}

function fatal(msg) {
  console.error(`[build] FATAL: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  log(`Running: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    ...opts,
  });
  if (result.status !== 0) {
    fatal(`${cmd} failed with exit code ${result.status}`);
  }
}

// Fix workspace protocol dependencies
function fixWorkspaceDeps() {
  const packageFiles = [
    "packages/core/package.json",
    "packages/gateway/package.json",
    "packages/installer/package.json",
    "packages/skills/package.json",
  ];

  let fixedCount = 0;

  for (const file of packageFiles) {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) continue;

    const content = fs.readFileSync(fullPath, "utf-8");
    const pkg = JSON.parse(content);

    let modified = false;
    if (pkg.dependencies) {
      for (const dep in pkg.dependencies) {
        if (pkg.dependencies[dep] === "workspace:^") {
          pkg.dependencies[dep] = "1.0.0";
          modified = true;
        }
      }
    }

    if (modified) {
      fs.writeFileSync(fullPath, JSON.stringify(pkg, null, 2), "utf-8");
      log(`Fixed workspace: ^ in ${file}`);
      fixedCount++;
    }
  }

  return fixedCount;
}

// Check if turbo is available and use it
function tryTurboBuild() {
  try {
    const tscResult = spawnSync("npx", ["turbo", "run", "build"], {
      stdio: "ignore",
    });
    if (tscResult.status === 0) {
      log("Used turbo for build");
      return true;
    }
  } catch (e) {}
  return false;
}

// Main build function
function main() {
  const startTime = Date.now();
  log("Starting Hiro build...");

  // Clean dist directories
  log("Cleaning previous builds...");
  const distFolders = ["dist", "dist/runtime", ...new Set(["packages/*/dist", "packages/*/dist/*"].flat())];
  for (const folder of new Set(distFolders)) {
    const fullPath = path.join(root, folder);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      log(`Cleaned ${folder}`);
    }
  }

  // Fix workspace dependencies
  log("Fixing workspace: ^ dependencies...");
  const fixed = fixWorkspaceDeps();
  log(`Fixed ${fixed} package(s) with workspace: ^ dependencies`);

  // Try to use turbo for building
  if (tryTurboBuild()) {
    log("Build completed using turbo");
  } else {
    // Fallback: compile TypeScript
    log("Using TypeScript compilation fallback...");
    run("npx", ["tsc", "-b", "--force"], { cwd: root });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log("");
  log("========================================");
  log(`  Build complete! (${elapsed}s)`);
  log(`  Runtime: dist/runtime/`);
  log("  Ready for distribution");
  log("========================================");
}

main();