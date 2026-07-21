#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

function log(msg) {
  console.log(`[fix] ${msg}`);
}

function fatal(msg) {
  console.error(`[fix] FATAL: ${msg}`);
  process.exit(1);
}

function fixPackage(dir, pkgName) {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return;

  const content = fs.readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(content);

  let modified = false;

  if (pkg.name === pkgName) {
    if (pkg.dependencies) {
      for (const dep in pkg.dependencies) {
        if (pkg.dependencies[dep] === "workspace:^" || pkg.dependencies[dep] === "workspace:~" || pkg.dependencies[dep] === "workspace:") {
          pkg.dependencies[dep] = "1.0.0";
          modified = true;
          log(`Replaced ${dep} with workspace: ^ in ${pkgName} package.json`);
        }
      }
    }

    if (modified) {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");
      log(`Fixed ${pkgName} package.json`);
    }
  }
}

function main() {
  const packageNames = [
    "@hiro/cli",
    "@hiro/config", 
    "@hiro/core",
    "@hiro/gateway",
    "@hiro/installer",
    "@hiro/skills",
  ];

  log("Fixing workspace protocol dependencies...");

  for (const pkgName of packageNames) {
    // Find the package directory
    const fullPkgPath = path.join(root, "packages", pkgName.split("/")[1]);
    if (fs.existsSync(fullPkgPath)) {
      fixPackage(fullPkgPath, pkgName);
    } else if (pkgName === "@hiro/cli" && fs.existsSync(path.join(root, "packages", "cli"))) {
      fixPackage(path.join(root, "packages", "cli"), pkgName);
    }
  }

  log("Package fixing complete");
}

main();