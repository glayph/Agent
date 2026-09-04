/**
 * @miki/config — shared runtime settings, secrets helpers, and types.
 * Signatures match actual core/gateway call sites.
 */

import type { VoiceMessageMetadata } from "./types.js";
export type { VoiceMessageMetadata } from "./types.js";

export interface ChatAttachment {
  type: "image" | "audio" | "video" | "file";
  url: string;
  filename?: string;
  content_type?: string;
}
import {
  migrateRuntimeConfig as migrateSchemaRuntimeConfig,
  validateRuntimeConfig as validateSchemaRuntimeConfig,
} from "./schema.js";
export { SpeechToTextSchema } from "./schema.js";
export type { SpeechToTextSettings } from "./schema.js";
import {
  resolveConfiguredSecret as resolvePersistentSecret,
  setConfiguredSecret as setPersistentSecret,
  loadConfiguredSecretsIntoEnv as loadPersistentSecrets,
  userConfigDir,
} from "./user-config.js";
// userConfigDir was previously only defined in user-config.ts and never
// re-exported from this module's public surface, even though
// setConfiguredSecret's success messages and the `miki config path` /
// `miki setup` CLI commands all call it via `import("@miki/config")`. That
// left `userConfigDir is not a function` errors on every config-writing
// command in a source checkout.
export { userConfigDir };
import {
  createWorkspaceSecretVault as createPersistentWorkspaceSecretVault,
  loadVaultSecretsIntoEnv as loadWorkspaceVaultSecretsIntoEnv,
  resolveEnvSecret as resolveWorkspaceEnvSecret,
  setEnvSecret as setWorkspaceEnvSecret,
} from "./secret-vault.js";

export interface ChatMessage {
  /** Stable identifier used by persisted session history mutations. */
  id?: string;
  /** ISO creation timestamp for persisted session history. */
  created_at?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Image URLs or data URLs to be serialized as provider image content parts. */
  image_urls?: string[];
  attachments?: ChatAttachment[];
  voice?: VoiceMessageMetadata;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type?: "function";
    function: { name: string; arguments: string };
    /** Provider-native metadata returned on an individual tool call. */
    extra_content?: Record<string, unknown>;
  }>;
  /** Provider-native assistant metadata, such as Gemini thought signatures. */
  extra_content?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface LLMResponse {
  content?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices?: Array<{
    message?: { content?: string; role?: string; tool_calls?: unknown[] };
    finish_reason?: string;
  }>;
}

export interface RuntimeConfig {
  dataDir?: string;
  model?: string;
  defaultModel?: string;
  temperature?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface ConfigValidationResult {
  valid: boolean;
  ok: boolean;
  errors: Array<{ path?: string; message: string; code?: string }>;
  warnings: Array<{ path?: string; message: string; code?: string }>;
  config: RuntimeConfig;
  value: RuntimeConfig;
  [key: string]: unknown;
}

export interface SecretVault {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  list(): string[];
}

export interface SecretStatusItem {
  key: string;
  present: boolean;
  envOnly?: boolean;
  inVault?: boolean;
  source?: string;
  migrated?: boolean;
}

// Keep the provider-qualified identifier aligned with the low-cost Flash
// fallback used by the Miki runtime and dashboard readiness contract.
export const DEFAULT_GEMINI_MODEL = "gemini/gemini-3.5-flash-lite";
export const DEFAULT_GEMINI_PROVIDER = "gemini";

const SECRET_KEYS = [
  "GEMINI_API_KEY",
  "MIKI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
];

export const settings: RuntimeConfig & {
  getSupportedModels: () => string[];
  setModel: (model: string) => void;
  defaultModel: string;
  defaultTemperature: number;
  defaultMaxTokens: number;
  provider: string;
  corePort: number;
  coreHost: string;
} = {
  dataDir: process.env.MIKI_DATA_DIR || "./data",
  // Gemini is the safe, explicit default. MIKI_MODEL may select Gemini or
  // the local llama.cpp plugin only.
  model: process.env.MIKI_MODEL || DEFAULT_GEMINI_MODEL,
  defaultModel: process.env.MIKI_MODEL || DEFAULT_GEMINI_MODEL,
  temperature: 0.2,
  defaultTemperature: Number(process.env.DEFAULT_TEMPERATURE || 0.7) || 0.7,
  maxTokens: 4096,
  defaultMaxTokens: Number(process.env.DEFAULT_MAX_TOKENS || 4096) || 4096,
  provider: process.env.MIKI_PROVIDER || DEFAULT_GEMINI_PROVIDER,
  corePort: Number(process.env.CORE_PORT || 8000) || 8000,
  coreHost: process.env.CORE_HOST || "127.0.0.1",
  getSupportedModels() {
    return [
      DEFAULT_GEMINI_MODEL,
      "gemini/gemini-3.6-flash",
      "gemini/gemini-3.5-flash",
      "llama.cpp/local-model",
    ];
  },
  setModel(model: string) {
    this.model = model;
    this.defaultModel = model;
    process.env.MIKI_MODEL = model;
  },
};

export function validateRuntimeConfig(
  cfg: RuntimeConfig = settings,
  opts?: unknown,
): ConfigValidationResult {
  const result = validateSchemaRuntimeConfig(
    cfg as Record<string, unknown>,
    (opts ?? {}) as { allowedChannelNames?: string[] },
  );
  const config = result.config as unknown as RuntimeConfig;
  return {
    ...result,
    valid: result.valid,
    ok: result.valid,
    config,
    value: config,
  };
}

export function migrateRuntimeConfig(
  cfg: RuntimeConfig = settings,
  _opts?: unknown,
): RuntimeConfig {
  return migrateSchemaRuntimeConfig(
    cfg as Record<string, unknown>,
  ) as unknown as RuntimeConfig;
}

export function readMikiEnv(
  key: string,
  fallback?: string,
  ..._rest: unknown[]
): string | undefined {
  const full = key.startsWith("MIKI_") ? key : `MIKI_${key}`;
  const v = process.env[full] ?? process.env[key];
  if (v !== undefined && v !== "") return v;
  return fallback;
}

export function isSandboxModeEnabled(
  _workspaceDir?: string,
  ..._rest: unknown[]
): boolean {
  const v = (
    readMikiEnv("SANDBOX") ||
    process.env.MIKI_SANDBOX ||
    ""
  ).toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

const REDACTED_VALUE = "[REDACTED]";

function isSensitiveField(key: string): boolean {
  const normalized = key.trim().toLowerCase().replace(/[-\s]/g, "_");
  if (!normalized) return false;
  return (
    normalized === "secret" ||
    normalized === "token" ||
    normalized === "password" ||
    normalized === "authorization" ||
    normalized === "auth" ||
    normalized === "private_key" ||
    normalized === "client_secret" ||
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_token") ||
    normalized.endsWith("_secret") ||
    normalized.endsWith("_password") ||
    normalized.endsWith("_authorization") ||
    normalized.endsWith("_private_key")
  );
}

function redactSecretLiterals(value: string): string {
  return value
    .replace(
      /(api[_-]?key|token|secret|password|authorization)\s*([:=])\s*["']?[^\s"',}]+/gi,
      `$1$2${REDACTED_VALUE}`,
    )
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED_VALUE}`)
    .replace(
      /\b(?:sk|pk|rk|ghp|xox[baprs]-|AIza)[A-Za-z0-9_\-]{12,}\b/g,
      REDACTED_VALUE,
    );
}

export function redactSecrets<T>(input: T, ..._rest: unknown[]): T;
export function redactSecrets(input: unknown, ..._rest: unknown[]): unknown {
  if (input == null) return input;
  if (typeof input === "string") return redactSecretLiterals(input);
  if (Array.isArray(input)) return input.map((value) => redactSecrets(value));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      input as Record<string, unknown>,
    )) {
      out[key] = isSensitiveField(key) ? REDACTED_VALUE : redactSecrets(value);
    }
    return out;
  }
  return input;
}

const secretStore = new Map<string, string>();

export function isSecretEnvKey(key: string): boolean {
  return (
    /(_API_KEY|_TOKEN|_SECRET|PASSWORD|AUTH)$/i.test(key) ||
    SECRET_KEYS.includes(key)
  );
}

export function resolveConfiguredSecret(
  name: string,
  workspaceDir?: string,
  ..._rest: unknown[]
): string | undefined {
  if (workspaceDir) {
    // Previously this branch skipped resolvePersistentSecret entirely, so a
    // key saved via `miki config set` / `miki setup` (which writes through
    // setConfiguredSecret -> the user config vault under userConfigDir())
    // was invisible to any caller that passed a workspaceDir, such as
    // `miki config get` and the doctor's provider-key check. Both halves of
    // the config set/get round trip now consult the same user vault.
    const workspaceValue = name.startsWith("env/")
      ? createPersistentWorkspaceSecretVault(workspaceDir).get(name)
      : resolveWorkspaceEnvSecret(name, workspaceDir);
    return (
      workspaceValue ||
      resolvePersistentSecret(name) ||
      process.env[name] ||
      process.env[`MIKI_${name}`] ||
      process.env[name.toUpperCase()]
    );
  }
  return (
    secretStore.get(name) ||
    resolvePersistentSecret(name) ||
    process.env[name] ||
    process.env[`MIKI_${name}`] ||
    process.env[name.toUpperCase()]
  );
}

export function setConfiguredSecret(
  name: string,
  value: string,
  ..._rest: unknown[]
): void {
  secretStore.set(name, value);
  setPersistentSecret(name, value);
  process.env[name] = value;
}

export function setEnvSecret(
  name: string,
  value: string,
  workspaceDir?: string,
  ..._rest: unknown[]
): void {
  if (workspaceDir) {
    setWorkspaceEnvSecret(name, value, workspaceDir);
    return;
  }
  setConfiguredSecret(name, value);
}

export function loadConfiguredSecretsIntoEnv(
  _a?: unknown,
  workspaceDir?: string,
  ..._rest: unknown[]
): void {
  if (workspaceDir) {
    loadWorkspaceVaultSecretsIntoEnv({ workspaceDir });
    return;
  }
  loadPersistentSecrets(undefined);
  for (const [k, v] of secretStore) {
    if (!process.env[k]) process.env[k] = v;
  }
}

export function loadVaultSecretsIntoEnv(
  _a?: unknown,
  workspaceDir?: string,
  ..._rest: unknown[]
): void {
  if (workspaceDir) {
    loadWorkspaceVaultSecretsIntoEnv({ workspaceDir });
    return;
  }
  loadConfiguredSecretsIntoEnv();
}

export function reloadProviderSecretsIntoEnv(
  _a?: unknown,
  workspaceDir?: string,
  ..._rest: unknown[]
): void {
  loadConfiguredSecretsIntoEnv(undefined, workspaceDir);
}

export function migrateEnvSecretsToVault(
  _a?: unknown,
  _b?: unknown,
): Array<{ key: string; migrated: boolean }> {
  const result: Array<{ key: string; migrated: boolean }> = [];
  for (const key of SECRET_KEYS) {
    const v = process.env[key];
    if (v && !secretStore.has(key)) {
      secretStore.set(key, v);
      result.push({ key, migrated: true });
    } else {
      result.push({ key, migrated: false });
    }
  }
  return result;
}

export function createWorkspaceSecretVault(
  workspaceId?: string,
  ..._rest: unknown[]
): SecretVault {
  const vault = createPersistentWorkspaceSecretVault(workspaceId);
  return {
    get: (key) => vault.get(key) ?? undefined,
    set: (key, value) => vault.set(key, value),
    delete: (key) => vault.delete(key),
    list: () =>
      Array.from(
        new Set([
          ...vault.list(),
          ...secretStore.keys(),
          ...SECRET_KEYS.filter((key) => resolveConfiguredSecret(key)),
        ]),
      ),
  };
}

/** Returns array so callers can .filter / .map */
export function inspectEnvSecretStatus(
  _opts?: { workspaceDir?: string } | string,
): SecretStatusItem[] {
  return SECRET_KEYS.map((key) => {
    const inVault = Boolean(resolvePersistentSecret(key));
    const inEnv = Boolean(process.env[key] || process.env[`MIKI_${key}`]);
    return {
      key,
      present: inVault || inEnv,
      inVault,
      envOnly: inEnv && !inVault,
      source: inVault ? "vault" : inEnv ? "env" : undefined,
    };
  });
}

export function resolveAllowedCidrsFromEnv(_opts?: unknown): string[] {
  const raw =
    readMikiEnv("ALLOWED_CIDRS") ||
    process.env.MIKI_ALLOWED_CIDRS ||
    process.env.ALLOWED_CIDRS ||
    "";
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export {
  isIpAllowedByCidrs,
  isValidCidr,
  normalizeAllowedCidrs,
} from "./security.js";

export default settings;
