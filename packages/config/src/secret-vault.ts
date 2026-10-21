import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FILE_NAME = "secret-vault.json";
const KEY_FILE_NAME = "secret-vault.key";
const LEGACY_BACKUP_NAME = "secret-vault.v1-backup.json";
/** Version 2: random key file (or MIKI_VAULT_KEY passphrase) instead of hostname-derived keys. */
const FORMAT_VERSION = 2;
/** Version 1: key derived from user/hostname/path. Read-only compatibility. */
const LEGACY_FORMAT_VERSION = 1;
const DEFAULT_SECRET_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "IRC_PASSWORD",
  "IRC_NICKSERV_PASSWORD",
  "IRC_SASL_PASSWORD",
];

type VaultKdf = "keyfile" | "passphrase";

type VaultEnvelope = {
  version: number;
  kdf?: VaultKdf;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

/**
 * Raised when the vault exists but cannot be read safely. Writers must never
 * replace such a file: doing so would silently destroy every stored secret.
 */
export class SecretVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretVaultError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function stringEntries(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function dataDir(root: string): string {
  return path.join(path.resolve(root || process.cwd()), "data");
}

function vaultFilePath(root: string): string {
  return path.join(dataDir(root), FILE_NAME);
}

function keyFilePath(root: string): string {
  return path.join(dataDir(root), KEY_FILE_NAME);
}

function explicitPassphrase(): string | undefined {
  return (
    process.env.MIKI_VAULT_KEY || process.env.MIKI_SECRET_VAULT_KEY
  )?.trim() || undefined;
}

function scryptKey(seed: string, salt: Buffer): Buffer {
  return crypto.scryptSync(seed, salt, 32, { N: 16_384, r: 8, p: 1 });
}

/** Version 1 derivation. Only used to read vaults written by older builds. */
function legacyKey(root: string, salt: Buffer): Buffer {
  const seed =
    explicitPassphrase() ||
    `${os.userInfo().username}:${os.hostname()}:${path.resolve(root)}`;
  return scryptKey(seed, salt);
}

function readKeyFile(root: string): Buffer | undefined {
  const file = keyFilePath(root);
  try {
    const key = fs.readFileSync(file);
    if (key.length !== 32) {
      throw new SecretVaultError(`Secret vault key file is corrupt: ${file}`);
    }
    return key;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function readOrCreateKeyFile(root: string): Buffer {
  const existing = readKeyFile(root);
  if (existing) return existing;
  const key = crypto.randomBytes(32);
  fs.mkdirSync(dataDir(root), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(keyFilePath(root), key, { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = readKeyFile(root);
      if (raced) return raced;
    }
    throw error;
  }
}

function keyForEnvelope(
  root: string,
  envelope: VaultEnvelope,
  salt: Buffer,
): Buffer {
  if (envelope.version === LEGACY_FORMAT_VERSION) return legacyKey(root, salt);
  if (envelope.kdf === "passphrase") {
    const passphrase = explicitPassphrase();
    if (!passphrase) {
      throw new SecretVaultError(
        "This secret vault is protected by MIKI_VAULT_KEY, which is not set.",
      );
    }
    return scryptKey(passphrase, salt);
  }
  const key = readKeyFile(root);
  if (!key) {
    throw new SecretVaultError(
      `Secret vault key file is missing: ${keyFilePath(root)}`,
    );
  }
  return key;
}

/**
 * Reads the vault. Returns {} only when no vault file exists. Any other
 * problem throws, so callers cannot mistake an unreadable vault for an empty one.
 */
function readVaultFile(filePath: string, root: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SecretVaultError(
      `Secret vault is not valid JSON and was left untouched: ${filePath}`,
    );
  }
  if (!isObject(parsed)) {
    throw new SecretVaultError(`Secret vault is malformed: ${filePath}`);
  }
  if (isObject(parsed.secrets)) {
    return stringEntries(parsed.secrets);
  }

  const envelope = parsed as Partial<VaultEnvelope>;
  if (
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.salt !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string"
  ) {
    throw new SecretVaultError(`Secret vault envelope is malformed: ${filePath}`);
  }

  try {
    const salt = Buffer.from(envelope.salt, "base64");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      keyForEnvelope(root, envelope as VaultEnvelope, salt),
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const clear = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const decoded = JSON.parse(clear) as unknown;
    if (!isObject(decoded)) throw new Error("decoded payload is not an object");
    return stringEntries(decoded);
  } catch (error) {
    if (error instanceof SecretVaultError) throw error;
    throw new SecretVaultError(
      `Secret vault could not be decrypted and was left untouched to prevent data loss: ${filePath}`,
    );
  }
}

/** Keeps a copy of a version 1 vault before it is rewritten in the new format. */
function backupLegacyVault(filePath: string): void {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      version?: number;
    };
    const backup = path.join(path.dirname(filePath), LEGACY_BACKUP_NAME);
    if (raw?.version === LEGACY_FORMAT_VERSION && !fs.existsSync(backup)) {
      fs.copyFileSync(filePath, backup);
    }
  } catch {
    /* best effort: no file or not a version 1 envelope */
  }
}

function writeVaultFile(
  filePath: string,
  root: string,
  secrets: Record<string, string>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  backupLegacyVault(filePath);

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const passphrase = explicitPassphrase();
  const kdf: VaultKdf = passphrase ? "passphrase" : "keyfile";
  const key = passphrase
    ? scryptKey(passphrase, salt)
    : readOrCreateKeyFile(root);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(secrets), "utf8")),
    cipher.final(),
  ]);
  const envelope: VaultEnvelope = {
    version: FORMAT_VERSION,
    kdf,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort on Windows */
  }
}

export interface SecretVault {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  list(): string[];
}

function warnVault(error: unknown): void {
  console.warn(
    `[miki] secret vault unavailable: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export function createWorkspaceSecretVault(
  workspaceId = process.cwd(),
): SecretVault {
  const root = path.resolve(workspaceId);
  const filePath = vaultFilePath(root);
  // Reads degrade to "not set" with a warning. Writes and deletes throw when the
  // current vault cannot be read, so an unreadable vault is never overwritten.
  const load = () => readVaultFile(filePath, root);
  const save = (secrets: Record<string, string>) =>
    writeVaultFile(filePath, root, secrets);
  return {
    get(key) {
      try {
        return load()[key];
      } catch (error) {
        warnVault(error);
        return undefined;
      }
    },
    set(key, value) {
      const normalized = key.trim();
      if (!normalized) throw new Error("Secret key must not be empty");
      const secrets = load();
      if (!value) delete secrets[normalized];
      else secrets[normalized] = value;
      save(secrets);
    },
    delete(key) {
      const secrets = load();
      const existed = Object.prototype.hasOwnProperty.call(secrets, key);
      if (existed) {
        delete secrets[key];
        save(secrets);
      }
      return existed;
    },
    list() {
      try {
        return Object.keys(load()).sort();
      } catch (error) {
        warnVault(error);
        return [];
      }
    },
  };
}

export function isSecretEnvKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  return (
    DEFAULT_SECRET_KEYS.includes(normalized) ||
    /(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTH)$/.test(normalized)
  );
}

export function resolveEnvSecret(key: string, workspaceDir?: string): string {
  const normalized = key.trim().toUpperCase();
  const configured = [
    process.env[key],
    process.env[normalized],
    process.env[`MIKI_${normalized}`],
  ].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  if (configured) return configured;
  if (!workspaceDir) return "";
  const vault = createWorkspaceSecretVault(workspaceDir);
  return vault.get(`env/${normalized}`) || vault.get(normalized) || "";
}

export function setEnvSecret(
  key: string,
  value: string,
  workspaceDir?: string,
): void {
  const normalized = key.trim().toUpperCase();
  if (!normalized) throw new Error("Secret key must not be empty");
  if (workspaceDir) {
    createWorkspaceSecretVault(workspaceDir).set(`env/${normalized}`, value);
  } else if (value) {
    process.env[normalized] = value;
  } else {
    delete process.env[normalized];
  }
}

export function loadVaultSecretsIntoEnv(
  optionsOrKeys?: readonly string[] | { workspaceDir?: string },
  workspaceDir?: string,
): void {
  const root = !Array.isArray(optionsOrKeys)
    ? (optionsOrKeys as { workspaceDir?: string } | undefined)?.workspaceDir
    : workspaceDir;
  if (!root) return;
  const vault = createWorkspaceSecretVault(root);
  for (const key of vault.list()) {
    if (!key.startsWith("env/")) continue;
    const envKey = key.slice(4);
    if (envKey && !process.env[envKey]) {
      const value = vault.get(key);
      if (value) process.env[envKey] = value;
    }
  }
}
