#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(packageRoot, "src");
const outputRoot = path.join(packageRoot, "dist", "catalog");

function copyRuntimeFiles(source, destination) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyRuntimeFiles(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }

  // Skill source is documentation and metadata. TypeScript source is not
  // copied into the runtime catalog; executable bundled entries are copied
  // separately from dist below after compilation.
  if (/\.(?:ts|tsx|mts|cts|map)$/i.test(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

if (!fs.existsSync(sourceRoot)) {
  throw new Error(`Skills source directory is missing: ${sourceRoot}`);
}

fs.rmSync(outputRoot, { recursive: true, force: true });
copyRuntimeFiles(sourceRoot, outputRoot);

// goal-completion is the bundled executable skill today. Keep this generic
// enough to include future compiled entries without copying TypeScript.
const compiledRoot = path.join(packageRoot, "dist");
function copyCompiledEntries(source, destination) {
  if (!fs.existsSync(source)) return;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "catalog" || entry.name.endsWith(".d.ts") || entry.name.endsWith(".map")) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyCompiledEntries(sourcePath, destinationPath);
    } else if (entry.name.endsWith(".js")) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}
copyCompiledEntries(compiledRoot, outputRoot);

let fileCount = 0;
function countFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) countFiles(target);
    else fileCount += 1;
  }
}
countFiles(outputRoot);
console.log(`[skills] Built bundled catalog: ${outputRoot} (${fileCount} files)`);
