#!/usr/bin/env node
/**
 * Recovery chaos test. Each scenario breaks something on purpose and checks that Miki recovers and the user
 * still gets exactly one answer.
 *
 *   node scripts/recovery-chaos.mjs            run all scenarios
 *   node scripts/recovery-chaos.mjs --only kill9,poison
 *
 * The real gateway modules (outbox, recovery manager, replay sweeper, process safety, channel runtime) are compiled
 * to a temporary folder and run in a child process against a real SQLite file and a local stand-in for the Telegram
 * API, so `kill -9` and process crashes are real. The model is a stand-in controlled by a flag file.
 * Hang and watchdog behaviour is checked against the real supervisor; connection behaviour (Discord RESUME, ACK
 * watchdog, Slack stale timeout, catch-up) and the health script are checked through their own test suites.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const only = (process.argv.find((a) => a.startsWith("--only=")) || (process.argv.includes("--only") ? `--only=${process.argv[process.argv.indexOf("--only") + 1]}` : "")).replace("--only=", "").split(",").filter(Boolean);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, ms = 20_000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await wait(50); }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- compile the gateway modules once -------------------------------------------------------------------------
const buildDir = path.join(root, ".chaos-build");
function compile() {
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "package.json"), '{"type":"module"}');
  for (const name of ["outbox", "recovery-manager", "replay-sweeper", "recovery-learning", "process-safety", "channel-runtime", "notice-fallback"]) {
    const source = fs.readFileSync(path.join(root, "packages", "gateway", "src", `${name}.ts`), "utf8");
    const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
    fs.writeFileSync(path.join(buildDir, `${name}.js`), out.outputText);
  }
}

// ---- the child process: Miki's channel delivery + recovery on a real database ------------------------------------
const CHILD = `
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import readline from "node:readline";
import { ChannelRuntimeManager } from "./channel-runtime.js";
import { ChannelDeliveryStore } from "./outbox.js";
import { RecoveryManager } from "./recovery-manager.js";
import { ReplaySweeper } from "./replay-sweeper.js";
import { beginBoot, markCleanExit } from "./process-safety.js";

const { DB, FLAGS, TG_PORT } = process.env;
const flag = (name) => fs.existsSync(path.join(FLAGS, name));
const db = new Database(DB);
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT, kind TEXT DEFAULT 'normal', context_id TEXT, status TEXT DEFAULT 'completed', status_detail TEXT)");
const boot = beginBoot(db, path.dirname(DB), () => {});

// A message that crashes the whole process, like a real poison message, but only when it is run.
const processMessage = (id, contextId, sessionId, text) => {
  if (flag("model-down")) { db.prepare("UPDATE chat_messages SET status='failed', status_detail='fetch failed: ECONNREFUSED' WHERE id=?").run(id); return { runId: "r-" + id, status: "failed" }; }
  if (text.includes("POISON")) { process.exit(1); }
  const at = new Date().toISOString();
  db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id,kind) VALUES(?,?,?,?,?,?,'normal')").run("a-" + id, sessionId, "assistant", "answer to: " + text, at, contextId);
  db.prepare("UPDATE chat_messages SET status='completed', status_detail=NULL WHERE id=?").run(id);
  return { runId: "r-" + id, status: "completed" };
};
const chatTurns = {
  async run(input) {
    const t = input.trigger;
    if (t.mode === "carryover") {
      const row = db.prepare("SELECT id,content,status FROM chat_messages WHERE id=? AND role='user' AND status='queued'").get(t.carryoverMessageId);
      if (!row) return { status: "rejected" };
      if (flag("slow")) await new Promise((r) => setTimeout(r, 400));
      return processMessage(row.id, input.contextId, input.sessionId, row.content);
    }
    if (db.prepare("SELECT id FROM chat_messages WHERE id=?").get(t.clientMessageId)) return { status: "duplicate" };
    db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id,status) VALUES(?,?,?,?,?,?,'processing')").run(t.clientMessageId, input.sessionId, "user", t.content, new Date().toISOString(), input.contextId);
    if (flag("hold")) await new Promise(() => {}); // the process is killed while the answer is being made
    return processMessage(t.clientMessageId, input.contextId, input.sessionId, t.content);
  },
  async waitForRun() { return "completed"; },
  isContextActive() { return false; },
};
const config = { channel_list: { telegram: { enabled: true, allow_from: ["1"], settings: { token: "t" } } } };
const fetchImpl = (url, init) => fetch(String(url).replace("https://api.telegram.org", "http://127.0.0.1:" + TG_PORT), init);
const delivery = new ChannelDeliveryStore(db, { baseDelayMs: 50, maxDelayMs: 200 });
const manager = new ChannelRuntimeManager({ db, chatTurns, getAppConfig: () => config, log: (m) => console.log("LOG " + m), fetchImpl, delivery });
const sweeper = new ReplaySweeper({
  db, isContextActive: () => false, log: (m) => console.log("LOG " + m), maxAttempts: 3,
  replay: (m) => manager.resumeInbound(m.id, () => chatTurns.run({ sessionId: m.session_id, contextId: m.context_id || m.session_id, peerId: m.session_id, trigger: { type: "user", mode: "carryover", content: "", attachments: [], carryoverMessageId: m.id } })),
  onGivenUp: (m, why) => manager.noticeForMessage(m.id, why),
});
const recovery = new RecoveryManager({
  db, intervalMs: 100, requiredGreen: 3, log: (m) => console.log("LOG " + m),
  check: async () => (flag("model-down") || flag("tg-down")) ? { ok: false, reason: "network is down" } : { ok: true },
  onRecovered: async () => { manager.flushOutbox(); const r = await sweeper.sweep("recovered"); return r.replayed; },
});
recovery.start();
manager.flushOutbox();
// Crash loop: set aside the messages that were being worked on when the process died.
if (boot.crashLoop) {
  for (const row of db.prepare("SELECT id FROM chat_messages WHERE role='user' AND status IN ('processing','retrying')").all()) {
    db.prepare("UPDATE chat_messages SET status='failed', status_detail='set aside after repeated crashes', replay_state='quarantined' WHERE id=?").run(row.id);
    manager.noticeForMessage(row.id, "quarantined");
  }
}
if (!process.env.NO_STARTUP_SWEEP) await sweeper.sweep("startup");
process.on("SIGTERM", () => { markCleanExit(path.dirname(DB)); process.exit(0); });
console.log("READY");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.cmd === "message") void manager.dispatchMessage({ channel: "telegram", address: "100", senderId: "1", eventId: msg.id, text: msg.text, allowFrom: ["1"], entry: { state: {} } }).catch((e) => console.log("LOG dispatch " + e.message));
  if (msg.cmd === "sweep") void sweeper.sweep("manual");
});
`;

// ---- harness --------------------------------------------------------------------------------------------------
async function startTelegram(flags) {
  const received = [];
  const server = http.createServer((req, res) => {
    if (fs.existsSync(path.join(flags, "tg-down"))) { req.socket.destroy(); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url.includes("sendMessage")) received.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: [] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { received, port: server.address().port, close: () => server.close() };
}

function startChild(env) {
  const child = childProcess.spawn(process.execPath, [path.join(buildDir, "child.mjs")], { cwd: root, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (c) => { buffer += c; let i; while ((i = buffer.indexOf("\n")) >= 0) { lines.push(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
  child.stderr.on("data", (c) => process.env.CHAOS_VERBOSE && process.stderr.write(c));
  child.lines = lines;
  child.exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  child.say = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  return child;
}

async function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-chaos-"));
  const flags = path.join(dir, "flags");
  fs.mkdirSync(flags);
  const tg = await startTelegram(flags);
  const env = { DB: path.join(dir, "miki-runtime.sqlite"), FLAGS: flags, TG_PORT: String(tg.port) };
  const setFlag = (name, on) => (on ? fs.writeFileSync(path.join(flags, name), "1") : fs.rmSync(path.join(flags, name), { force: true }));
  const children = [];
  // allowCrash: the child may legitimately die during startup (a poison message is replayed there).
  const boot = async (extra = {}, allowCrash = false) => { const c = startChild({ ...env, ...extra }); children.push(c); await waitFor(() => c.lines.includes("READY") || c.exitCode !== null, 15_000, "child READY"); if (c.exitCode !== null && !allowCrash) throw new Error("child exited at startup"); return c; };
  const replies = () => tg.received.map((m) => m.text);
  // Stop every child first (and wait for it), otherwise it may still be writing while the folder is removed.
  const cleanup = async () => {
    for (const c of children) { if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); }
    await Promise.all(children.map((c) => c.exited));
    if (process.env.CHAOS_VERBOSE) { for (const c of children) console.log(c.lines.slice(-25).join("\n")); console.log("telegram received:", JSON.stringify(tg.received)); try { const d = openDb(env.DB); console.log(JSON.stringify(d.prepare("SELECT id,role,status,status_detail,replay_attempts,created_at FROM chat_messages ORDER BY created_at").all())); console.log(JSON.stringify(d.prepare("SELECT idempotency_key,status,attempts,last_error FROM channel_outbox").all())); console.log(JSON.stringify(d.prepare("SELECT platform_event_id,status FROM channel_inbox").all())); } catch (e) { console.log("db dump failed", e.message); } }
    tg.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { dir, env, tg, setFlag, boot, replies, cleanup };
}

const scenarios = {
  // 1. The gateway dies while the answer is being made: after the restart the user gets exactly one answer.
  async kill9() {
    const w = await world();
    try {
      w.setFlag("hold", true);
      let child = await w.boot();
      child.say({ cmd: "message", id: "m1", text: "hello" });
      await wait(500);
      child.kill("SIGKILL");
      await child.exited;
      w.setFlag("hold", false);
      child = await w.boot();
      await waitFor(() => w.replies().length >= 1, 15_000, "the answer after restart");
      await wait(600);
      assertEqual(w.replies(), ["answer to: hello"], "exactly one answer after kill -9");
      child.kill("SIGTERM");
    } finally { await w.cleanup(); }
  },

  // 2. Network cut (model and Telegram unreachable): three messages are answered, in order, once it is back.
  async network() {
    const w = await world();
    try {
      const child = await w.boot();
      w.setFlag("model-down", true); w.setFlag("tg-down", true);
      for (const n of [1, 2, 3]) { child.say({ cmd: "message", id: `n${n}`, text: `question ${n}` }); await wait(80); }
      await wait(2500); // two minutes in the real world; the point is that nothing is delivered while it is down
      assertEqual(w.replies(), [], "nothing is delivered while the network is down");
      w.setFlag("model-down", false); w.setFlag("tg-down", false);
      await waitFor(() => w.replies().filter((t) => t.startsWith("answer to:")).length >= 3, 20_000, "three answers after the network returned");
      assertEqual(w.replies().filter((t) => t.startsWith("answer to:")), ["answer to: question 1", "answer to: question 2", "answer to: question 3"], "answers in order, no duplicates");
      child.kill("SIGTERM");
    } finally { await w.cleanup(); }
  },

  // 3. Only Telegram is blocked at the moment of sending: the reply waits in the outbox, then arrives once.
  async outbox() {
    const w = await world();
    try {
      const child = await w.boot();
      w.setFlag("tg-down", true);
      child.say({ cmd: "message", id: "o1", text: "ping" });
      await wait(1500);
      assertEqual(w.replies(), [], "reply is waiting, not lost");
      const pending = new (await import(path.join(buildDir, "outbox.js"))).ChannelDeliveryStore(openDb(w.env.DB)).stats().pending;
      if (pending !== 1) throw new Error(`expected 1 pending reply in the outbox, found ${pending}`);
      w.setFlag("tg-down", false);
      await waitFor(() => w.replies().length >= 1, 20_000, "the waiting reply");
      await wait(800);
      assertEqual(w.replies(), ["answer to: ping"], "delivered once, not duplicated");
      child.kill("SIGTERM");
    } finally { await w.cleanup(); }
  },

  // 4. Hang (SIGSTOP) is handled by the real supervisor's watchdog.
  async hang() { runNode([path.join(root, "scripts", "miki-24-7.integration.test.mjs")], "supervisor integration (includes the SIGSTOP hang scenario)"); },

  // 5. A message that crashes the process is tried a few times, then set aside; Miki keeps serving everything else.
  async poison() {
    const w = await world();
    try {
      let child = await w.boot();
      child.say({ cmd: "message", id: "p1", text: "POISON please" });
      let crashes = 0;
      for (; crashes < 8; crashes += 1) {
        const exit = await Promise.race([child.exited, wait(2000).then(() => null)]);
        if (exit === null) break; // it stayed up: the message was set aside
        child = await w.boot({}, true);
      }
      if (crashes >= 8) throw new Error("the poison message kept crashing Miki");
      await waitFor(() => w.replies().some((t) => t.includes("request_set_aside")), 10_000, "the notice that the message was set aside");
      child.say({ cmd: "message", id: "p2", text: "a normal question" });
      await waitFor(() => w.replies().includes("answer to: a normal question"), 10_000, "a normal answer after the poison message");
      child.kill("SIGTERM");
    } finally { await w.cleanup(); }
  },

  // 6. Discord / Slack disconnects: RESUME, heartbeat ACK watchdog, stale timeout and catch-up have their own tests.
  async channels() { runJest(["-t", "Discord:|Slack:|connection hardening"], "channel connection hardening tests"); },

  // 7. Model server down / loading: the health script never restarts a loading server, and restarts a dead one only after repeated failures.
  async model() { runNode([path.join(root, "scripts", "healthcheck-dryrun.mjs")], "health script dry run (model loading vs model dead)"); },

  // 8. Damaged database: restored from the newest backup, and the incident is on record.
  async db() {
    const { ensureHealthyDatabase, DatabaseBackups, recordDatabaseIncident } = await import(path.join(buildDir, "process-safety.js"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-chaos-db-"));
    try {
      const file = path.join(dir, "miki-runtime.sqlite");
      const Database = require("better-sqlite3");
      const db = new Database(file); db.exec("CREATE TABLE t(v)"); db.prepare("INSERT INTO t VALUES('kept')").run();
      await new DatabaseBackups(db, path.join(dir, "backups"), () => {}).backupNow();
      db.close();
      fs.writeFileSync(file, Buffer.alloc(4096, 7)); // damage it
      const result = ensureHealthyDatabase(file, path.join(dir, "backups"), () => {});
      assertEqual(result.status, "restored", "database restored from backup");
      const restored = new Database(file);
      assertEqual(restored.prepare("SELECT v FROM t").get().v, "kept", "data is back");
      recordDatabaseIncident(restored, result, new Date().toISOString());
      if (restored.prepare("SELECT COUNT(*) n FROM recovery_incidents WHERE reason LIKE 'database:%'").get().n !== 1) throw new Error("incident not recorded");
      restored.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
};

function openDb(file) { const Database = require("better-sqlite3"); return new Database(file); }
function assertEqual(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function runNode(args, label) {
  const r = childProcess.spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${label} failed`);
}
function runJest(extra, label) {
  const r = childProcess.spawnSync(process.execPath, ["--experimental-vm-modules", path.join(root, "node_modules", "jest", "bin", "jest.js"), "--config=jest.config.cjs", "--runInBand", "--runTestsByPath", "packages/gateway/src/channel-runtime.test.ts", ...extra], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${label} failed`);
}

compile();
fs.writeFileSync(path.join(buildDir, "child.mjs"), CHILD);
let failed = 0;
for (const [name, fn] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  const started = Date.now();
  try { await fn(); console.log(`\x1b[32mPASS\x1b[0m ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`); }
  catch (error) { failed += 1; console.log(`\x1b[31mFAIL\x1b[0m ${name}: ${error instanceof Error ? error.message : error}`); }
}
fs.rmSync(buildDir, { recursive: true, force: true });
console.log(failed === 0 ? "[recovery-chaos] all scenarios passed" : `[recovery-chaos] ${failed} scenario(s) failed`);
process.exit(failed === 0 ? 0 : 1);
