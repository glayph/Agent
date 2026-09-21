#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

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
    `PASS better-sqlite3 native binding (${process.platform}-${process.arch})`,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
