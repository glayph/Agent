import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const VAULT_VERSION = 1;
const DEFAULT_KEY_PATH = path.join("data", "secret-vault.key");
const DEFAULT_VAULT_PATH = path.join("data", "secret-vault.json");
const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|token|secret|password|credential|refresh[_-]?token|access[_-]?token|authorization)/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,
];

export const DEFAULT_SECRET_ENV_KEYS = [
  "API_KEY",
  "API_KEY_SECRET",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "TAVILY_API_KEY",
  "SERPAPI_API_KEY",
  "LITELLM_MASTER_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "FEISHU_APP_SECRET",
  "FEISHU_ENCRYPT_KEY",
  "FEISHU_VERIFICATION_TOKEN",
  "DINGTALK_WEBHOOK_URL",
  "DINGTALK_CLIENT_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "QQ_BOT_TOKEN",
  "ONEBOT_ACCESS_TOKEN",
  "WEIXIN_TOKEN",
  "WEIXIN_ENCODING_AES_KEY",
  "WECOM_SECRET",
  "WECOM_CORP_SECRET",
  "WECOM_WEBHOOK_URL",
  "WHATSAPP_WEBHOOK_TOKEN",
  "MATRIX_ACCESS_TOKEN",
  "IRC_PASSWORD",
  "IRC_NICKSERV_PASSWORD",
  "IRC_SASL_PASSWORD",
  "MQTT_USERNAME",
  "MQTT_PASSWORD",
] as const;

const SECRET_ENV_KEY_PATTERN =
  /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i;

interface StoredSecret {
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
}

interface VaultFile {
  version: number;
  updatedAt: string;
  secrets: Record<string, StoredSecret>;
}

export interface SecretMetadata {
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretVault {
  set(name: string, value: string): void;
  get(name: string): string | null;
  delete(name: string): boolean;
  rotate(name: string, value: string): void;
  list(): SecretMetadata[];
}

export interface FileEncryptedSecretVaultOptions {
  workspaceDir?: string;
  vaultPath?: string;
  keyPath?: string;
  key?: string;
}

export interface EnvSecretMigrationResult {
  key: string;
  secretName: string;
  source: "vault" | "env" | "missing";
  migrated: boolean;
}

export interface EnvSecretStatus {
  key: string;
  secretName: string;
  inVault: boolean;
  inEnv: boolean;
  envOnly: boolean;
}

function normalizeSecretName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new Error("Secret name is required.");
  }
  if (!/^[A-Za-z0-9_.:/-]+$/.test(normalized)) {
    throw new Error("Secret name contains unsupported characters.");
  }
  return normalized;
}

function keyFromString(value: string): Buffer {
  const trimmed = value.trim();
  for (const encoding of ["base64url", "base64"] as const) {
    try {
      const decoded = Buffer.from(trimmed, encoding);
      if (decoded.length === 32) return decoded;
    } catch {
      // Fall through to hashing.
    }
  }
  return crypto.createHash("sha256").update(trimmed).digest();
}

function resolveKey(options: FileEncryptedSecretVaultOptions): Buffer {
  if (options.key?.trim()) {
    return keyFromString(options.key);
  }

  const envKey = process.env["Hiro_SECRET_VAULT_KEY"];
  if (envKey?.trim()) {
    return keyFromString(envKey);
  }

  const workspaceDir = path.resolve(options.workspaceDir || process.cwd());
  const keyPath = path.resolve(
    workspaceDir,
    options.keyPath || DEFAULT_KEY_PATH,
  );
  try {
    const persisted = fs.readFileSync(keyPath, "utf-8").trim();
    if (persisted) return keyFromString(persisted);
  } catch {
    // Generate below.
  }

  const generated = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, generated, { encoding: "utf-8", mode: 0o600 });
  return keyFromString(generated);
}

function emptyVault(): VaultFile {
  return {
    version: VAULT_VERSION,
    updatedAt: new Date().toISOString(),
    secrets: {},
  };
}

export class FileEncryptedSecretVault implements SecretVault {
  private readonly vaultPath: string;
  private readonly key: Buffer;

  constructor(options: FileEncryptedSecretVaultOptions = {}) {
    const workspaceDir = path.resolve(options.workspaceDir || process.cwd());
    this.vaultPath = path.resolve(
      workspaceDir,
      options.vaultPath || DEFAULT_VAULT_PATH,
    );
    this.key = resolveKey(options);
  }

  set(name: string, value: string): void {
    const secretName = normalizeSecretName(name);
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("Secret value is required.");
    }
    const vault = this.readVault();
    const now = new Date().toISOString();
    const existing = vault.secrets[secretName];
    vault.secrets[secretName] = {
      ...this.encrypt(value),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.writeVault(vault);
  }

  get(name: string): string | null {
    const secretName = normalizeSecretName(name);
    const secret = this.readVault().secrets[secretName];
    return secret ? this.decrypt(secret) : null;
  }

  delete(name: string): boolean {
    const secretName = normalizeSecretName(name);
    const vault = this.readVault();
    if (!vault.secrets[secretName]) return false;
    delete vault.secrets[secretName];
    this.writeVault(vault);
    return true;
  }

  rotate(name: string, value: string): void {
    if (!this.delete(name)) {
      normalizeSecretName(name);
    }
    this.set(name, value);
  }

  list(): SecretMetadata[] {
    return Object.entries(this.readVault().secrets)
      .map(([name, secret]) => ({
        name,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private encrypt(
    value: string,
  ): Pick<StoredSecret, "iv" | "tag" | "ciphertext"> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf-8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString("base64url"),
      tag: tag.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
  }

  private decrypt(secret: StoredSecret): string {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(secret.iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(secret.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf-8");
  }

  private readVault(): VaultFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.vaultPath, "utf-8"));
      if (
        parsed &&
        parsed.version === VAULT_VERSION &&
        parsed.secrets &&
        typeof parsed.secrets === "object"
      ) {
        return parsed as VaultFile;
      }
      throw new Error("Unsupported secret vault format.");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return emptyVault();
      this.backupCorruptVault();
      return emptyVault();
    }
  }

  private backupCorruptVault(): void {
    if (!fs.existsSync(this.vaultPath)) return;
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${this.vaultPath}.corrupt-${suffix}`;
    try {
      fs.renameSync(this.vaultPath, backupPath);
    } catch {
      // If backup fails, keep the original error path deterministic by
      // returning an empty vault instead of writing partial replacement data.
    }
  }

  private writeVault(vault: VaultFile): void {
    vault.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.vaultPath), { recursive: true });
    const tmpPath = `${this.vaultPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(vault, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, this.vaultPath);
  }
}

function workspaceFromOptions(workspaceDir?: string): string {
  return path.resolve(
    workspaceDir || process.env["Hiro_WORKSPACE_DIR"] || process.cwd(),
  );
}

export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY_PATTERN.test(key);
}

export function secretNameForEnvKey(key: string): string {
  return `env/${key.trim().toUpperCase()}`;
}

export function createWorkspaceSecretVault(
  workspaceDir?: string,
): FileEncryptedSecretVault {
  return new FileEncryptedSecretVault({
    workspaceDir: workspaceFromOptions(workspaceDir),
  });
}

export function resolveEnvSecret(key: string, workspaceDir?: string): string {
  const secretName = secretNameForEnvKey(key);
  try {
    const value = createWorkspaceSecretVault(workspaceDir).get(secretName);
    if (value) return value;
  } catch {
    // Fall back to process.env so an unreadable vault does not break legacy
    // startup paths. Doctor reports vault health separately.
  }
  return process.env[key] || "";
}

export function setEnvSecret(
  key: string,
  value: string,
  workspaceDir?: string,
): void {
  const secretName = secretNameForEnvKey(key);
  const vault = createWorkspaceSecretVault(workspaceDir);
  if (value) {
    vault.set(secretName, value);
    process.env[key] = value;
  } else {
    vault.delete(secretName);
    delete process.env[key];
  }
}

export function loadVaultSecretsIntoEnv(
  options: {
    workspaceDir?: string;
    envKeys?: readonly string[];
  } = {},
): EnvSecretMigrationResult[] {
  const envKeys = options.envKeys || DEFAULT_SECRET_ENV_KEYS;
  const vault = createWorkspaceSecretVault(options.workspaceDir);
  return envKeys.map((key) => {
    const secretName = secretNameForEnvKey(key);
    const value = vault.get(secretName);
    if (value) {
      process.env[key] = value;
      return { key, secretName, source: "vault", migrated: false };
    }
    return {
      key,
      secretName,
      source: process.env[key] ? "env" : "missing",
      migrated: false,
    };
  });
}

export function migrateEnvSecretsToVault(
  options: {
    workspaceDir?: string;
    envKeys?: readonly string[];
  } = {},
): EnvSecretMigrationResult[] {
  const envKeys = options.envKeys || DEFAULT_SECRET_ENV_KEYS;
  const vault = createWorkspaceSecretVault(options.workspaceDir);
  return envKeys.map((key) => {
    const secretName = secretNameForEnvKey(key);
    const existing = vault.get(secretName);
    if (existing) {
      process.env[key] = existing;
      return { key, secretName, source: "vault", migrated: false };
    }
    const envValue = process.env[key];
    if (envValue) {
      vault.set(secretName, envValue);
      return { key, secretName, source: "env", migrated: true };
    }
    return { key, secretName, source: "missing", migrated: false };
  });
}

export function inspectEnvSecretStatus(
  options: {
    workspaceDir?: string;
    envKeys?: readonly string[];
  } = {},
): EnvSecretStatus[] {
  const envKeys = options.envKeys || DEFAULT_SECRET_ENV_KEYS;
  const vaultNames = new Set(
    createWorkspaceSecretVault(options.workspaceDir)
      .list()
      .map((item) => item.name),
  );
  return envKeys.map((key) => {
    const secretName = secretNameForEnvKey(key);
    const inVault = vaultNames.has(secretName);
    const inEnv = Boolean(process.env[key]);
    return {
      key,
      secretName,
      inVault,
      inEnv,
      envOnly: inEnv && !inVault,
    };
  });
}

function maskSecretValue(value: string): string {
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 3)}...[REDACTED]...${value.slice(-3)}`;
}

export function redactSecrets<T>(value: T, knownSecrets: string[] = []): T {
  const redactString = (input: string): string => {
    let output = input;
    for (const secret of knownSecrets.filter((item) => item.length >= 4)) {
      output = output.split(secret).join(maskSecretValue(secret));
    }
    for (const pattern of SECRET_VALUE_PATTERNS) {
      output = output.replace(pattern, (match) => maskSecretValue(match));
    }
    return output;
  };

  const visit = (input: unknown, key?: string): unknown => {
    if (typeof input === "string") {
      return key && SECRET_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : redactString(input);
    }
    if (Array.isArray(input)) {
      return input.map((item) => visit(item));
    }
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(input)) {
        out[childKey] = SECRET_KEY_PATTERN.test(childKey)
          ? "[REDACTED]"
          : visit(childValue, childKey);
      }
      return out;
    }
    return input;
  };

  return visit(value) as T;
}
