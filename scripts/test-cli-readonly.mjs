#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "bin", "miki.js");
for (const [label, args, expected] of [
  ["help", ["--help"], "miki CLI Command Reference"],
  ["version", ["--version"], "1.3.14"],
  ["weke", ["weke"], "miki weke: ready"],
]) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, MIKI_RUNTIME_ROOT: "" },
  });
  assert.equal(
    result.status,
    0,
    `${label} exited ${result.status}: ${result.stderr}`,
  );
  assert.match(
    result.stdout,
    new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.doesNotMatch(
    result.stdout,
    /Starting miki dashboard|Starting local Agent Miki gateway/,
  );
}
console.log("PASS CLI read-only commands do not start runtime services");
