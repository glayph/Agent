#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(root, "dist", "runtime");

const requiredFiles = [
  "runtime-loader.mjs",
  "packages/config/dist/index.js",
  "packages/installer/dist/index.js",
  "packages/skills/dist/index.js",
  "packages/core/dist/api/index.js",
  "packages/gateway/dist/index.js",
  "packages/ui/frontend/dist/index.html",
  "config/agent.yaml",
  "config/tools.yaml",
  "packages/core/package.json",
  ".env.example",
  "LICENSE",
];

function fail(message) {
  console.error(`[pack:check] FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(runtimeRoot)) {
  fail("dist/runtime is missing; run the production build first.");
}

const missing = requiredFiles.filter(
  (relativePath) => !fs.existsSync(path.join(runtimeRoot, relativePath)),
);
if (missing.length > 0) {
  fail(`missing required runtime files: ${missing.join(", ")}`);
}

const forbiddenNames = new Set([".env", "secret-vault.json"]);
const forbidden = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (forbiddenNames.has(entry.name)) forbidden.push(path.relative(runtimeRoot, full));
  }
}
walk(runtimeRoot);
if (forbidden.length > 0) {
  fail(`forbidden credential files found: ${forbidden.join(", ")}`);
}

const manifestPath = path.join(runtimeRoot, "packages", "core", "package.json");
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`runtime package.json is invalid: ${error.message}`);
}
if (!manifest?.name || !manifest?.version) {
  fail("runtime package.json must include name and version.");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      runtimeRoot,
      version: manifest.version,
      requiredFiles: requiredFiles.length,
      forbiddenFiles: 0,
    },
    null,
    2,
  ),
);
