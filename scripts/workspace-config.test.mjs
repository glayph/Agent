import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedWorkspaceConfig } from "./workspace-config.mjs";

test("seeds default agent and tool config into a fresh runtime workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-workspace-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const configDir = path.join(root, "runtime", "config");
  fs.mkdirSync(path.join(sourceRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "config", "agent.yaml"), "heartbeat:\n  enabled: true\n");
  fs.writeFileSync(path.join(sourceRoot, "config", "tools.yaml"), "tools: []\n");

  assert.deepEqual(seedWorkspaceConfig(sourceRoot, configDir), ["agent.yaml", "tools.yaml"]);
  assert.equal(fs.readFileSync(path.join(configDir, "agent.yaml"), "utf8"), "heartbeat:\n  enabled: true\n");
  assert.equal(fs.readFileSync(path.join(configDir, "tools.yaml"), "utf8"), "tools: []\n");
});

test("preserves existing workspace config and seeds only missing defaults", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-workspace-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const configDir = path.join(root, "runtime", "config");
  fs.mkdirSync(path.join(sourceRoot, "config"), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "config", "agent.yaml"), "default: true\n");
  fs.writeFileSync(path.join(sourceRoot, "config", "tools.yaml"), "tools: []\n");
  fs.writeFileSync(path.join(configDir, "agent.yaml"), "owner: customized\n");

  assert.deepEqual(seedWorkspaceConfig(sourceRoot, configDir), ["tools.yaml"]);
  assert.equal(fs.readFileSync(path.join(configDir, "agent.yaml"), "utf8"), "owner: customized\n");
  assert.deepEqual(seedWorkspaceConfig(sourceRoot, configDir), []);
});
