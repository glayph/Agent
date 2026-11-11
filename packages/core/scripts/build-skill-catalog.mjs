#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(packageRoot, "src", "plugins", "skills", "catalog");
const outputRoot = path.join(packageRoot, "dist", "plugins", "skills", "catalog");

function copyRuntimeFiles(source, destination) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyRuntimeFiles(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  // TypeScript is compiled by the core build. Only static catalog assets are copied.
  if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs|map|d\.ts)$/i.test(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

if (!fs.existsSync(sourceRoot)) {
  throw new Error(`Skills catalog directory is missing: ${sourceRoot}`);
}
fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
copyRuntimeFiles(sourceRoot, outputRoot);

let fileCount = 0;
function countFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) countFiles(target);
    else fileCount += 1;
  }
}
countFiles(outputRoot);
console.log(`[skills] Built core bundled catalog: ${outputRoot} (${fileCount} static files)`);
