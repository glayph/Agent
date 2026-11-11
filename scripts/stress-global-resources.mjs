#!/usr/bin/env node
/** Cross-process contention test for the SQLite GlobalResourceArbiter. */
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const workers = readInt("--workers", 6, 2, 32);
const iterations = readInt("--iterations", 20, 1, 1000);
const holdMs = readInt("--hold-ms", 12, 1, 1000);
const timeoutMs = readInt("--timeout-ms", 15_000, 1_000, 120_000);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "miki-resource-stress-"));
const dbPath = path.join(scratch, "arbiter.sqlite");
const arbiterPath = path.join(scratch, "global-resource-arbiter.mjs");

function readInt(name, fallback, min, max) {
  const index = process.argv.indexOf(name);
  const parsed = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function compileArbiter() {
  const sourcePath = path.join(root, "packages/gateway/src/runtime/global-resource-arbiter.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  });
  fs.writeFileSync(arbiterPath, result.outputText);
}

function workerSource(workerIndex) {
  return `import Database from 'better-sqlite3';
import { GlobalResourceArbiter } from ${JSON.stringify(pathToFileURL(arbiterPath).href)};
const db = new Database(${JSON.stringify(dbPath)});
db.pragma('busy_timeout = 10000');
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS stress_guard (slot INTEGER PRIMARY KEY CHECK(slot=1), owner TEXT NOT NULL, entered_at TEXT NOT NULL)');
const arbiter = new GlobalResourceArbiter(db, { pollMs: 5, leaseMs: 10000 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let count = 0;
for (let i=0;i<${iterations};i++) {
  const owner = 'worker-${workerIndex}-' + i;
  const lease = await arbiter.acquire(owner, [{ resource: 'shared_interactive' }], { priority: ${workerIndex === 0 ? 100 : 10}, timeoutMs: ${timeoutMs}, leaseMs: 10000 });
  try {
    const insert = db.prepare('INSERT INTO stress_guard(slot,owner,entered_at) VALUES(1,?,?)');
    try { insert.run(owner, new Date().toISOString()); }
    catch (error) { if (String(error).includes('UNIQUE constraint failed')) throw new Error('OVERLAP: two processes entered a globally exclusive resource'); throw error; }
    await sleep(${holdMs});
    const row = db.prepare('SELECT owner FROM stress_guard WHERE slot=1').get();
    if (row?.owner !== owner) throw new Error('GUARD_OWNER_CHANGED');
    db.prepare('DELETE FROM stress_guard WHERE slot=1 AND owner=?').run(owner);
    count++;
  } finally { lease.release(); }
}
console.log(JSON.stringify({ worker: ${workerIndex}, completed: count }));
db.close();`;
}

compileArbiter();
const Database = require("better-sqlite3");
const bootstrapDb = new Database(dbPath);
bootstrapDb.pragma("journal_mode = WAL");
bootstrapDb.pragma("busy_timeout = 10000");
bootstrapDb.exec("CREATE TABLE IF NOT EXISTS stress_guard (slot INTEGER PRIMARY KEY CHECK(slot=1), owner TEXT NOT NULL, entered_at TEXT NOT NULL)");
bootstrapDb.close();
const children = [];
try {
  const results = await Promise.all(Array.from({ length: workers }, (_, workerIndex) => new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ["--input-type=module", "-e", workerSource(workerIndex)], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout.trim().split("\n").at(-1))); }
        catch { reject(new Error(`Worker ${workerIndex} returned invalid output: ${stdout}\n${stderr}`)); }
      } else reject(new Error(`Worker ${workerIndex} failed (${code}): ${stderr || stdout}`));
    });
  })));
  const totalCompleted = results.reduce((sum, item) => sum + item.completed, 0);
  const db = createRequire(import.meta.url)("better-sqlite3");
  const verify = new db(dbPath, { readonly: true });
  const remaining = Number(verify.prepare("SELECT COUNT(*) AS count FROM stress_guard").get().count);
  const remainingLeases = Number(verify.prepare("SELECT COUNT(*) AS count FROM miki_global_resource_leases").get().count);
  const remainingWaiters = Number(verify.prepare("SELECT COUNT(*) AS count FROM miki_global_resource_waiters").get().count);
  verify.close();
  if (totalCompleted !== workers * iterations || remaining !== 0 || remainingLeases !== 0 || remainingWaiters !== 0) {
    throw new Error("Cross-process resource stress invariants failed.");
  }
  console.log(JSON.stringify({ status: "passed", workers, iterationsPerWorker: iterations, totalCompleted, remainingGuardRows: remaining, remainingLeases, remainingWaiters }, null, 2));
} catch (error) {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
