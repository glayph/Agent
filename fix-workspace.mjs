#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function fixWorkspaceDeps() {
  const packages = ["core", "gateway", "installer", "skills"];
  let fixedCount = 0;

  for (const pkg of packages) {
    const packageJsonPath = path.join(root, "packages", pkg, "package.json");
    if (!fs.existsSync(packageJsonPath)) continue;

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    let modified = false;

    if (packageJson.dependencies) {
      for (const dep in packageJson.dependencies) {
        if (packageJson.dependencies[dep] === "workspace:^") {
          packageJson.dependencies[dep] = "1.0.0";
          modified = true;
        }
      }
    }

    if (modified) {
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), "utf-8");
      console.log(`Fixed workspace: ^ in packages/${pkg}/package.json`);
      fixedCount++;
    }
  }

  return fixedCount;
}

const fixed = fixWorkspaceDeps();
console.log(`Fixed ${fixed} package(s) with workspace: ^ dependencies`);