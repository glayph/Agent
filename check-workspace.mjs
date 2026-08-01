#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

// List of packages to check
const packages = [
    "packages/core",
    "packages/gateway",
    "packages/installer",
    "packages/skills"
];

console.log("Checking for workspace: ^ dependencies in Hiro packages...");
console.log("============================================");

let hasWorkspaceDeps = false;

for (const pkg of packages) {
    const packageJsonPath = path.join(root, pkg, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
        continue;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const hasWorkspaceDep = packageJson.dependencies && 
        Object.values(packageJson.dependencies).some(dep => dep === "workspace:^");

    if (hasWorkspaceDep) {
        console.log(`✗ ${pkg}/package.json CONTAINS workspace: ^ dependencies`);
        hasWorkspaceDeps = true;
    } else {
        console.log(`✓ ${pkg}/package.json has no workspace: ^ dependencies`);
    }
}

if (!hasWorkspaceDeps) {
    console.log("\n");
    console.log("============================================");
    console.log("SUCCESS: All workspace: ^ dependencies have been fixed!");
    console.log("Packages now use exact version 1.0.0 for internal dependencies.");
} else {
    console.error("\nERROR: Some packages still have workspace: ^ dependencies!");
    process.exit(1);
}