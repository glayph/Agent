import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FILE_NAME = "secret-vault.json";
const FORMAT_VERSION = 1;
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

type VaultEnvelope = {
  version: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

type VaultFile =
  VaultEnvelope | { version?: number; secrets?: Record<string, string> };

function vaultFilePath(root: string): string {
  const resolved = path.resolve(root || process.cwd());
  return path.join(resolved, "data", FILE_NAME);
}

function keyFor(root: string, salt: Buffer): Buffer {
  const explicit =
    process.env.MIKI_VAULT_KEY || process.env.MIKI_SECRET_VAULT_KEY;
  const seed =
    explicit?.trim() ||
    `${os.userInfo().username}:${os.hostname()}:${path.resolve(root)}`;
  return crypto.scryptSync(seed, salt, 32, { N: 16_384, r: 8, p: 1 });
}

function decodeLegacy(file: VaultFile): Record<string, string> | undefined {
  if (
    !file ||
    typeof file !== "object" ||
    !("secrets" in file) ||
    !file.secrets
  )
    return undefined;
  return Object.fromEntries(
    Object.entries(file.secrets).filter(
      ([, value]) => typeof value === "string",
    ),
  );
}

function readSecrets(filePath: string, root: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as VaultFile;
    const legacy = decodeLegacy(parsed);
    if (legacy) return legacy;
    if (
      !("ciphertext" in parsed) ||
      typeof parsed.ciphertext !== "string" ||
      typeof parsed.salt !== "string" ||
      typeof parsed.iv !== "string" ||
      typeof parsed.tag !== "string"
    )
      return {};
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      keyFor(root, Buffer.from(parsed.salt, "base64")),
      Buffer.from(parsed.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    const clear = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const decoded = JSON.parse(clear) as unknown;
    return decoded && typeof decoded === "object"
      ? Object.fromEntries(
          Object.entries(decoded).filter(
            ([, value]) => typeof value === "string",
          ),
        )
      : {};
  } catch {
    return {};
  }
}

function writeSecrets(
  filePath: string,
  root: string,
  secrets: Record<string, string>,
): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(root, salt), iv);
  const clear = Buffer.from(JSON.stringify(secrets), "utf8");
  const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
  const envelope: VaultEnvelope = {
    version: FORMAT_VERSION,
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

export function createWorkspaceSecretVault(
  workspaceId = process.cwd(),
): SecretVault {
  const root = path.resolve(workspaceId);
  const filePath = vaultFilePath(root);
  const load = () => readSecrets(filePath, root);
  const save = (secrets: Record<string, string>) =>
    writeSecrets(filePath, root, secrets);
  return {
    get(key) {
      return load()[key];
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
      return Object.keys(load()).sort();
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
  return (
    createWorkspaceSecretVault(workspaceDir).get(`env/${normalized}`) ||
    createWorkspaceSecretVault(workspaceDir).get(normalized) ||
    ""
  );
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
