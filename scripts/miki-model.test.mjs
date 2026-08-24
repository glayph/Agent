import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manager = path.join(root, "scripts", "miki-model.mjs");

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [manager, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

test("lists a pinned catalog entry without network access", () => {
  const result = run(["list"]);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.catalog.length, 1);
  assert.equal(data.catalog[0].id, "gemma-4-E2B-it-Q4_0");
  assert.match(data.catalog[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(data.catalog[0].installed, false);
});

test("status uses isolated user paths", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
  const result = run(["status"], {
    MIKI_RUNTIME_ROOT: path.join(temp, "runtime"),
    MIKI_MODEL_DIR: path.join(temp, "models"),
    MIKI_STATE_PATH: path.join(temp, "runtime", "data", "launcher-state.json"),
    MIKI_CONFIG_DIR: path.join(temp, "runtime", "config"),
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.installed.length, 0);
  assert.equal(data.model_dir, path.join(temp, "models"));
  fs.rmSync(temp, { recursive: true, force: true });
});

test("rejects arbitrary model ids before any network request", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
  const result = run(["install", "https://example.invalid/model.gguf"], {
    MIKI_RUNTIME_ROOT: path.join(temp, "runtime"),
    MIKI_MODEL_DIR: path.join(temp, "models"),
    MIKI_STATE_PATH: path.join(temp, "runtime", "data", "launcher-state.json"),
    MIKI_CONFIG_DIR: path.join(temp, "runtime", "config"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown model/);
  assert.equal(fs.existsSync(path.join(temp, "models")), false);
  fs.rmSync(temp, { recursive: true, force: true });
});
