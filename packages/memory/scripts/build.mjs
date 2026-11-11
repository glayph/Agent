#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(packageRoot, "../..");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tsc)) {
  console.error("[miki:memory] TypeScript is unavailable. Install workspace dependencies first.");
  process.exit(1);
}
const result = spawnSync(process.execPath, [tsc, "-p", path.join(packageRoot, "tsconfig.file-memory.json")], {
  cwd: root, stdio: "inherit", shell: false,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const output = path.join(packageRoot, "dist", "file-memory");
mkdirSync(output, { recursive: true });
cpSync(path.join(packageRoot, "src", "file-memory", "package.json"), path.join(output, "package.json"));
console.log("[miki:memory] File-memory ESM subpath built.");
