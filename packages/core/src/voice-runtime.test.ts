import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { VoiceRuntimeManager } from "./voice-runtime.js";

function createRuntimeWorkspace(executableBody: string) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "miki-voice-runtime-test-"),
  );
  const configDir = path.join(root, "config");
  const modelPath = path.join(root, "data", "voice", "models", "base.bin");
  const executable = path.join(root, "whisper-cli.mjs");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(modelPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(modelPath, "test model", { mode: 0o600 });
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${executableBody}\n`, {
    mode: 0o700,
  });
  fs.writeFileSync(
    path.join(configDir, "agent.yaml"),
    "speech_to_text:\n  enabled: true\n",
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(root, "data", "voice", "state.json"),
    JSON.stringify({
      activeModelId: "base",
      models: {
        base: {
          id: "base",
          path: modelPath,
          installedAt: new Date(0).toISOString(),
          sha1: "test",
          enabled: true,
        },
      },
      runtime: { executable },
    }),
    { mode: 0o600 },
  );
  return { root, configDir, manager: new VoiceRuntimeManager(configDir) };
}

describe("VoiceRuntimeManager health", () => {
  it("requires the configured whisper executable to pass --help", async () => {
    const workspace = createRuntimeWorkspace("process.exit(0);");
    try {
      const status = await workspace.manager.health();
      expect(status.healthy).toBe(true);
      expect(status.reason).toContain("responded to --help");
    } finally {
      fs.rmSync(workspace.root, { recursive: true, force: true });
    }
  });

  it("reports a broken local whisper executable as unhealthy", async () => {
    const workspace = createRuntimeWorkspace("process.exit(2);");
    try {
      const status = await workspace.manager.health();
      expect(status.healthy).toBe(false);
      expect(status.reason).toContain("failed its --help check");
    } finally {
      fs.rmSync(workspace.root, { recursive: true, force: true });
    }
  });
});
