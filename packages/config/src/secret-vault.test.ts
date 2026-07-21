import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  FileEncryptedSecretVault,
  inspectEnvSecretStatus,
  migrateEnvSecretsToVault,
  redactSecrets,
  resolveEnvSecret,
  secretNameForEnvKey,
  setEnvSecret,
} from "./secret-vault.js";

describe("encrypted secret vault", () => {
  const originalOpenAIKey = process.env["OPENAI_API_KEY"];

  afterEach(() => {
    if (originalOpenAIKey === undefined) {
      delete process.env["OPENAI_API_KEY"];
    } else {
      process.env["OPENAI_API_KEY"] = originalOpenAIKey;
    }
  });

  it("stores encrypted secrets and supports rotation and deletion", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-vault-"));
    const vault = new FileEncryptedSecretVault({
      workspaceDir: tempDir,
      key: "test-key",
    });

    vault.set("models/openai/api_key", "sk-test-secret-value-1234567890");
    expect(vault.get("models/openai/api_key")).toBe(
      "sk-test-secret-value-1234567890",
    );

    const raw = fs.readFileSync(
      path.join(tempDir, "data", "secret-vault.json"),
      "utf-8",
    );
    expect(raw).not.toContain("sk-test-secret-value-1234567890");
    expect(vault.list()).toHaveLength(1);

    vault.rotate("models/openai/api_key", "sk-rotated-secret-value-1234567890");
    expect(vault.get("models/openai/api_key")).toBe(
      "sk-rotated-secret-value-1234567890",
    );
    expect(vault.delete("models/openai/api_key")).toBe(true);
    expect(vault.get("models/openai/api_key")).toBeNull();
  });

  it("migrates env secrets into vault and prefers vault values afterwards", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-vault-"));
    process.env["OPENAI_API_KEY"] = "sk-env-secret-value-1234567890";

    const migration = migrateEnvSecretsToVault({
      workspaceDir: tempDir,
      envKeys: ["OPENAI_API_KEY"],
    });

    expect(migration).toEqual([
      {
        key: "OPENAI_API_KEY",
        secretName: secretNameForEnvKey("OPENAI_API_KEY"),
        source: "env",
        migrated: true,
      },
    ]);
    expect(resolveEnvSecret("OPENAI_API_KEY", tempDir)).toBe(
      "sk-env-secret-value-1234567890",
    );

    process.env["OPENAI_API_KEY"] = "sk-env-stale-value-1234567890";
    setEnvSecret("OPENAI_API_KEY", "sk-vault-secret-value-1234567890", tempDir);
    expect(resolveEnvSecret("OPENAI_API_KEY", tempDir)).toBe(
      "sk-vault-secret-value-1234567890",
    );
    expect(
      inspectEnvSecretStatus({
        workspaceDir: tempDir,
        envKeys: ["OPENAI_API_KEY"],
      })[0],
    ).toMatchObject({ inVault: true, envOnly: false });
  });

  it("backs up corrupt vault files and recovers with an empty vault", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-vault-"));
    const vaultPath = path.join(tempDir, "data", "secret-vault.json");
    fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
    fs.writeFileSync(vaultPath, "{not-json", "utf-8");

    const vault = new FileEncryptedSecretVault({
      workspaceDir: tempDir,
      key: "test-key",
    });

    expect(vault.list()).toEqual([]);
    const backups = fs
      .readdirSync(path.dirname(vaultPath))
      .filter((name) => name.startsWith("secret-vault.json.corrupt-"));
    expect(backups).toHaveLength(1);
    vault.set("models/openai/api_key", "sk-new-secret-value-1234567890");
    expect(vault.get("models/openai/api_key")).toBe(
      "sk-new-secret-value-1234567890",
    );
  });

  it("redacts secret keys and known secret values from nested structures", () => {
    const redacted = redactSecrets(
      {
        api_key: "sk-test-secret-value-1234567890",
        nested: {
          message: "use token abcdefghijklmnopqrstuvwxyz123456",
        },
      },
      ["abcdefghijklmnopqrstuvwxyz123456"],
    );

    expect(redacted.api_key).toBe("[REDACTED]");
    expect(redacted.nested.message).not.toContain(
      "abcdefghijklmnopqrstuvwxyz123456",
    );
  });
});
