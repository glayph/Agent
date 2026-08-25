#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreStoreModule = path.join(
  scriptRoot,
  "packages",
  "core",
  "dist",
  "session-history-store.js",
);

function usage() {
  console.error("Usage: node scripts/miki-backup.mjs --source <db> --destination <db>");
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const source = getArg("--source");
const destination = getArg("--destination");
if (!source || !destination || process.argv.includes("--help")) {
  usage();
  process.exit(source && destination ? 0 : 2);
}

const sourcePath = path.resolve(source);
const destinationPath = path.resolve(destination);
if (!fs.existsSync(sourcePath)) {
  console.error(`Source database does not exist: ${sourcePath}`);
  process.exit(1);
}
if (sourcePath === destinationPath) {
  console.error("Source and destination must be different files");
  process.exit(2);
}
if (!fs.existsSync(coreStoreModule)) {
  console.error(`Core build not found: ${coreStoreModule}. Run npm run build:all first.`);
  process.exit(1);
}

const { SqliteSessionHistoryStore } = await import(
  pathToFileURL(coreStoreModule).href
);
const store = new SqliteSessionHistoryStore(sourcePath);
try {
  await store.backup(destinationPath);
  console.log(JSON.stringify({ ok: true, destination: destinationPath }));
} finally {
  store.close();
}
