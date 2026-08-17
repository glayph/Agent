/**
 * @miki/config — shared runtime settings, secrets helpers, and types.
 * Signatures match actual core/gateway call sites.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type?: "function";
    function: { name: string; arguments: string };
  }>;
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
  ok: boolean;
  errors: Array<{ path?: string; message: string }>;
  warnings: Array<{ path?: string; message: string }>;
  value?: RuntimeConfig;
  [key: string]: unknown;
}

export interface SecretVault {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
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

const SECRET_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
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
  provider: string;
} = {
  dataDir: process.env.MIKI_DATA_DIR || "./data",
  model: process.env.MIKI_MODEL || "gpt-4o-mini",
  defaultModel: process.env.MIKI_MODEL || "gpt-4o-mini",
  temperature: 0.2,
  defaultTemperature: Number(process.env.DEFAULT_TEMPERATURE || 0.7) || 0.7,
  maxTokens: 4096,
  provider: process.env.MIKI_PROVIDER || "openrouter",
  getSupportedModels() {
    return ["gpt-4o-mini", "gpt-4o", "claude-3-5-sonnet", "claude-3-opus"];
  },
  setModel(model: string) {
    this.model = model;
    this.defaultModel = model;
    process.env.MIKI_MODEL = model;
  },
};

export function validateRuntimeConfig(
  cfg: RuntimeConfig = settings,
  _opts?: unknown
): ConfigValidationResult {
  const errors: ConfigValidationResult["errors"] = [];
  const warnings: ConfigValidationResult["warnings"] = [];
  if (!cfg.dataDir) {
    cfg.dataDir = "./data";
    warnings.push({ path: "dataDir", message: "defaulted to ./data" });
  }
  return { ok: errors.length === 0, errors, warnings, value: cfg };
}

export function migrateRuntimeConfig(
  cfg: RuntimeConfig = settings,
  _opts?: unknown
): RuntimeConfig {
  validateRuntimeConfig(cfg);
  return cfg;
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

export function redactSecrets<T>(input: T, ..._rest: unknown[]): T;
export function redactSecrets(input: unknown, ..._rest: unknown[]): unknown {

  if (input == null) return input;
  if (typeof input === "string") {
    return input
      .replace(
        /(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^\s"']+/gi,
        "$1=***"
      )
      .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer ***");
  }
  if (Array.isArray(input)) return input.map((x) => redactSecrets(x));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (/key|token|secret|password|auth/i.test(k)) out[k] = "***";
      else out[k] = redactSecrets(v);
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

export function isValidCidr(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  if (value === "*") return true;
  // IPv4 or IPv4/CIDR
  return /^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(value.trim());
}

export function resolveConfiguredSecret(
  name: string,
  _workspaceDir?: string,
  ..._rest: unknown[]
): string | undefined {
  return (
    secretStore.get(name) ||
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
  process.env[name] = value;
}

export function setEnvSecret(
  name: string,
  value: string,
  ..._rest: unknown[]
): void {
  setConfiguredSecret(name, value);
}

export function loadConfiguredSecretsIntoEnv(
  _a?: unknown,
  _workspaceDir?: string,
  ..._rest: unknown[]
): void {
  for (const [k, v] of secretStore) {
    if (!process.env[k]) process.env[k] = v;
  }
}

export function loadVaultSecretsIntoEnv(
  _a?: unknown,
  _workspaceDir?: string,
  ..._rest: unknown[]
): void {
  loadConfiguredSecretsIntoEnv();
}

export function reloadProviderSecretsIntoEnv(
  _a?: unknown,
  _workspaceDir?: string,
  ..._rest: unknown[]
): void {
  loadConfiguredSecretsIntoEnv();
}

export function migrateEnvSecretsToVault(
  _a?: unknown,
  _b?: unknown
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
  _workspaceId?: string,
  ..._rest: unknown[]
): SecretVault {
  return {
    get: (key) => resolveConfiguredSecret(key),
    set: (key, value) => setConfiguredSecret(key, value),
    list: () => Array.from(new Set([...secretStore.keys(), ...SECRET_KEYS.filter((k) => process.env[k])])),
  };
}

/** Returns array so callers can .filter / .map */
export function inspectEnvSecretStatus(
  _opts?: { workspaceDir?: string } | string
): SecretStatusItem[] {
  return SECRET_KEYS.map((key) => {
    const inVault = secretStore.has(key);
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

export function resolveAllowedCidrsFromEnv(
  _opts?: unknown
): string[] {
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

export default settings;
