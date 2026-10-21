import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createWorkspaceSecretVault } from "./secret-vault.js";

describe("workspace secret vault durability", () => {
  const previousPassphrase = process.env["MIKI_VAULT_KEY"];
  let base: string;

  beforeEach(() => {
    delete process.env["MIKI_VAULT_KEY"];
    base = fs.mkdtempSync(path.join(os.tmpdir(), "miki-vault-"));
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousPassphrase === undefined) delete process.env["MIKI_VAULT_KEY"];
    else process.env["MIKI_VAULT_KEY"] = previousPassphrase;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("round-trips secrets with a stable key file", () => {
    const root = path.join(base, "cfg");
    createWorkspaceSecretVault(root).set("env/GEMINI_API_KEY", "AIzaSyTESTKEY123456");
    expect(createWorkspaceSecretVault(root).get("env/GEMINI_API_KEY")).toBe(
      "AIzaSyTESTKEY123456",
    );
    expect(fs.existsSync(path.join(root, "data", "secret-vault.key"))).toBe(true);
  });

  it("never overwrites a vault that cannot be read", () => {
    const root = path.join(base, "cfg");
    const file = path.join(root, "data", "secret-vault.json");
    createWorkspaceSecretVault(root).set("env/KEEP", "keep-me-123456");
    fs.writeFileSync(file, "{not json");
    expect(() =>
      createWorkspaceSecretVault(root).set("env/NEW", "value-123456"),
    ).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{not json");
  });

  it("reads a legacy hostname-derived vault and migrates it on write", () => {
    const root = path.join(base, "legacy");
    const file = path.join(root, "data", "secret-vault.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const seed = `${os.userInfo().username}:${os.hostname()}:${path.resolve(root)}`;
    const key = crypto.scryptSync(seed, salt, 32, { N: 16_384, r: 8, p: 1 });
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify({ "env/OLD": "legacy-key-99" }))),
      cipher.final(),
    ]);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      }),
    );

    expect(createWorkspaceSecretVault(root).get("env/OLD")).toBe("legacy-key-99");
    createWorkspaceSecretVault(root).set("env/NEW", "new-key-123456");
    expect(fs.existsSync(path.join(root, "data", "secret-vault.v1-backup.json"))).toBe(true);
    expect(createWorkspaceSecretVault(root).get("env/OLD")).toBe("legacy-key-99");
    expect(createWorkspaceSecretVault(root).get("env/NEW")).toBe("new-key-123456");
  });

  it("refuses writes when the key file is missing", () => {
    const root = path.join(base, "cfg");
    createWorkspaceSecretVault(root).set("env/A", "value-123456");
    fs.unlinkSync(path.join(root, "data", "secret-vault.key"));
    expect(createWorkspaceSecretVault(root).get("env/A")).toBeUndefined();
    expect(() => createWorkspaceSecretVault(root).set("env/B", "value-123456")).toThrow();
  });

  it("supports a passphrase-protected vault via MIKI_VAULT_KEY", () => {
    const root = path.join(base, "pass");
    process.env["MIKI_VAULT_KEY"] = "correct horse battery";
    createWorkspaceSecretVault(root).set("env/K", "pass-secret-1");
    expect(createWorkspaceSecretVault(root).get("env/K")).toBe("pass-secret-1");
    delete process.env["MIKI_VAULT_KEY"];
    expect(createWorkspaceSecretVault(root).get("env/K")).toBeUndefined();
    expect(() => createWorkspaceSecretVault(root).set("env/K2", "value-123456")).toThrow();
  });
});
