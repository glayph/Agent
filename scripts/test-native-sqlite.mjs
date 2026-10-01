#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoots = [
  root,
  path.join(root, "packages", "core"),
  path.join(root, "packages", "memory"),
];
const resolvedPackageFiles = workspaceRoots.map((workspaceRoot) =>
  require.resolve("better-sqlite3/package.json", { paths: [workspaceRoot] }),
);
const resolvedVersions = resolvedPackageFiles.map(
  (packageFile) => JSON.parse(fs.readFileSync(packageFile, "utf8")).version,
);
if (new Set(resolvedVersions).size !== 1) {
  throw new Error(
    `better-sqlite3 version mismatch across workspaces: ${resolvedVersions.join(", ")}`,
  );
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miki-sqlite-native-"));
const databasePath = path.join(directory, "native-test.sqlite");
try {
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO smoke (value) VALUES (?)");
  insert.run("native binding works");
  const row = db.prepare("SELECT value FROM smoke WHERE id = 1").get();
  if (row?.value !== "native binding works") {
    throw new Error(`unexpected SQLite result: ${JSON.stringify(row)}`);
  }
  db.close();
  console.log(
    `PASS better-sqlite3 native binding v${resolvedVersions[0]} (${process.platform}-${process.arch}); ` +
      `workspace resolutions: ${resolvedVersions.join(", ")}`,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
