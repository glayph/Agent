import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveConfiguredSecret, setConfiguredSecret } from "./index.js";

describe("resolveConfiguredSecret / setConfiguredSecret round trip", () => {
  const previousConfigDir = process.env["MIKIAGENT_CONFIG_DIR"];
  const previousVaultKey = process.env["MIKI_VAULT_KEY"];
  let tempConfigDir: string;
  let tempWorkspaceDir: string;

  beforeEach(() => {
    tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-user-config-"));
    tempWorkspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-workspace-"),
    );
    process.env["MIKIAGENT_CONFIG_DIR"] = tempConfigDir;
    // Fix the vault encryption key derivation to the temp dir so the test
    // doesn't depend on the real machine's username/hostname.
    process.env["MIKI_VAULT_KEY"] = "test-vault-key-for-secret-resolution";
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env["MIKIAGENT_CONFIG_DIR"];
    } else {
      process.env["MIKIAGENT_CONFIG_DIR"] = previousConfigDir;
    }
    if (previousVaultKey === undefined) {
      delete process.env["MIKI_VAULT_KEY"];
    } else {
      process.env["MIKI_VAULT_KEY"] = previousVaultKey;
    }
    delete process.env["GEMINI_API_KEY"];
    fs.rmSync(tempConfigDir, { recursive: true, force: true });
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  });

  it("finds a secret saved via setConfiguredSecret when no workspaceDir is passed", () => {
    setConfiguredSecret("GEMINI_API_KEY", "no-workspace-key");
    // setConfiguredSecret also mirrors into process.env; clear that so this
    // assertion exercises the user-config vault path, not the env fallback.
    delete process.env["GEMINI_API_KEY"];

    expect(resolveConfiguredSecret("GEMINI_API_KEY")).toBe("no-workspace-key");
  });

  it("finds a secret saved via setConfiguredSecret when a workspaceDir IS passed", () => {
    // Regression test: resolveConfiguredSecret's workspaceDir branch
    // previously skipped the user-config vault entirely, so a key saved by
    // `miki setup` / `miki config set` (which always writes through the
    // user-config vault) was invisible to any caller — such as
    // `miki config get` or the doctor's provider-key check — that passed a
    // workspaceDir. Both call shapes must resolve the same value.
    setConfiguredSecret("GEMINI_API_KEY", "with-workspace-key");
    delete process.env["GEMINI_API_KEY"];

    expect(resolveConfiguredSecret("GEMINI_API_KEY", tempWorkspaceDir)).toBe(
      "with-workspace-key",
    );
  });

  it("still prefers a live process.env value over the vault", () => {
    setConfiguredSecret("GEMINI_API_KEY", "vault-key");
    process.env["GEMINI_API_KEY"] = "env-key";

    expect(resolveConfiguredSecret("GEMINI_API_KEY", tempWorkspaceDir)).toBe(
      "env-key",
    );
  });

  it("returns undefined when nothing is configured anywhere", () => {
    expect(
      resolveConfiguredSecret("GEMINI_API_KEY", tempWorkspaceDir),
    ).toBeFalsy();
  });
});
