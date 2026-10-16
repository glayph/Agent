import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionLedger, categoryForTool } from "./permission-ledger.js";

function tempLedger(): { ledger: PermissionLedger; file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-permissions-test-"));
  const file = path.join(dir, "permissions.json");
  return { ledger: new PermissionLedger(file), file, dir };
}

test("no learned rules means every call is allowed", () => {
  const { ledger, dir } = tempLedger();
  assert.equal(ledger.evaluate("shell_execute", { command: "rm -rf /tmp/x" }).mode, "auto");
  assert.equal(ledger.evaluate("browser_click", { selector: "#go" }).mode, "auto");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an ask rule blocks only matching inputs and explains how to proceed", () => {
  const { ledger, dir } = tempLedger();
  ledger.learn({ category: "shell", match: "model:auto", decision: "ask", note: "ask before model setup" });
  const blocked = ledger.evaluate("shell_execute", { command: "npm run model:auto -- --start" });
  assert.equal(blocked.mode, "block");
  assert.match(blocked.reason, /permission_grant_once/);
  assert.equal(ledger.evaluate("shell_execute", { command: "npm test" }).mode, "auto");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a one-time grant lets exactly one asked-about call through", () => {
  const { ledger, dir } = tempLedger();
  ledger.learn({ category: "shell", match: "model:auto", decision: "ask", note: "" });
  ledger.grantOnce("shell", "model:auto");
  assert.equal(ledger.evaluate("shell_execute", { command: "npm run model:auto" }).mode, "auto");
  assert.equal(ledger.evaluate("shell_execute", { command: "npm run model:auto" }).mode, "block");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the most specific rule wins", () => {
  const { ledger, dir } = tempLedger();
  ledger.learn({ category: "shell", match: "", decision: "ask", note: "ask about shell" });
  ledger.learn({ category: "shell", match: "npm test", decision: "act", note: "npm test is fine" });
  assert.equal(ledger.evaluate("shell_execute", { command: "npm test" }).mode, "auto");
  assert.equal(ledger.evaluate("shell_execute", { command: "rm -rf build" }).mode, "block");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("learning the same category and match replaces the earlier rule", () => {
  const { ledger, dir } = tempLedger();
  ledger.learn({ category: "install", match: "", decision: "ask", note: "first" });
  ledger.learn({ category: "install", match: "", decision: "act", note: "second" });
  assert.equal(ledger.rules().length, 1);
  assert.equal(ledger.rules()[0].decision, "act");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rules persist to disk and reload in a new ledger", () => {
  const { ledger, file, dir } = tempLedger();
  ledger.learn({ category: "file_delete", match: "", decision: "ask", note: "ask before deleting" });
  const reloaded = new PermissionLedger(file);
  assert.equal(reloaded.evaluate("file_delete", { path: "a.txt" }).mode, "block");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("forget removes a learned rule", () => {
  const { ledger, dir } = tempLedger();
  ledger.learn({ category: "browser", match: "", decision: "ask", note: "" });
  assert.equal(ledger.forget("browser", ""), true);
  assert.equal(ledger.evaluate("browser_navigate", { url: "https://example.com" }).mode, "auto");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a corrupt ledger file is treated as empty instead of breaking the run", () => {
  const { file, dir } = tempLedger();
  fs.writeFileSync(file, "{ not json");
  const ledger = new PermissionLedger(file);
  assert.equal(ledger.rules().length, 0);
  assert.equal(ledger.evaluate("shell_execute", { command: "ls" }).mode, "auto");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tools map to stable categories", () => {
  assert.equal(categoryForTool("shell_execute"), "shell");
  assert.equal(categoryForTool("file_delete"), "file_delete");
  assert.equal(categoryForTool("browser_click"), "browser");
  assert.equal(categoryForTool("computer_click"), "computer_use");
  assert.equal(categoryForTool("web_fetch_custom"), "tool:web_fetch_custom");
});
