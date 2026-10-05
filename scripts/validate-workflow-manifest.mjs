#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "workflow.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const errors = [];

function checkFile(filePath, label) {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(root, filePath);
  if (!fs.existsSync(resolved)) errors.push(`${label} missing: ${resolved}`);
}

if (!manifest.scaffoldRoot || !manifest.outputDir) {
  errors.push("manifest must declare scaffoldRoot and outputDir");
} else if (path.resolve(manifest.scaffoldRoot) !== path.resolve(manifest.outputDir)) {
  errors.push("scaffoldRoot and outputDir must identify the same directory");
}

for (const file of manifest.writtenFiles ?? []) checkFile(file, "written file");
for (const file of manifest.scaffoldedFiles ?? []) checkFile(file, "scaffolded file");

for (const milestone of manifest.milestones ?? []) {
  for (const gate of milestone.gates ?? []) {
    const command = String(gate.command ?? "");
    const match = command.match(/node\s+([^\s]+)/);
    if (match?.[1]) checkFile(path.resolve(manifest.scaffoldRoot, match[1]), `gate script for ${gate.name}`);
  }
}

if (errors.length) {
  console.error("[workflow-manifest] INVALID");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`[workflow-manifest] valid: ${manifest.id}`);
console.log(`output: ${manifest.outputDir}`);
console.log(`files: ${(manifest.writtenFiles?.length ?? 0) + (manifest.scaffoldedFiles?.length ?? 0)}`);
