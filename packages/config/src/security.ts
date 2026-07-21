import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

const DEFAULT_GATEWAY_PORT = "18800";
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1"];
const DEFAULT_LITELLM_MASTER_KEY_PATH = path.join("data", "litellm.master-key");
const CORS_ALLOW_ALL_ORIGINS = "*";

export interface RequiredSecretOptions {
  weakValues?: string[];
  minLength?: number;
  label?: string;
}

export interface ResolvedLiteLLMMasterKeyOptions {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  filePath?: string;
  weakValues?: string[];
  minLength?: number;
}

export interface AllowedCorsOriginsOptions {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boolFromEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function bypassRestrictionsFromConfig(
  workspaceDir: string | undefined,
): boolean {
  if (!workspaceDir) return false;
  const configPath = path.join(workspaceDir, "config", "agent.yaml");
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf-8"));
    if (!isRecord(parsed)) return false;
    const agent = parsed.agent;
    if (!isRecord(agent)) return false;
    const security = agent.security;
    if (!isRecord(security)) return false;
    if (security["bypass_restrictions"] === true) return true;
    if (security["system_access"] === "full") return true;
    return false;
  } catch {
    return false;
  }
}

function isAllowedCorsOriginsOptions(
  value: AllowedCorsOriginsOptions | NodeJS.ProcessEnv,
): value is AllowedCorsOriginsOptions {
  return (
    Object.prototype.hasOwnProperty.call(value, "env") ||
    Object.prototype.hasOwnProperty.call(value, "workspaceDir")
  );
}

export function normalizeCorsOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized
      .split(".")
      .every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return false;
}

function isLoopbackBrowserOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function allowedCorsOriginsFromEnv(
  optionsOrEnv: AllowedCorsOriginsOptions | NodeJS.ProcessEnv = process.env,
): Set<string> {
  const options = isAllowedCorsOriginsOptions(optionsOrEnv)
    ? optionsOrEnv
    : { env: optionsOrEnv };
  const env = options.env ?? process.env;
  if (
    boolFromEnv(env["Hiro_BYPASS_RESTRICTIONS"]) ||
    bypassRestrictionsFromConfig(options.workspaceDir)
  ) {
    return new Set([CORS_ALLOW_ALL_ORIGINS]);
  }
  const configured = env["Hiro_ALLOWED_ORIGINS"];
  const rawOrigins =
    configured && configured.trim()
      ? configured.split(",")
      : DEFAULT_ALLOWED_HOSTS.map(
          (host) =>
            `http://${host}:${env["GATEWAY_PORT"] || DEFAULT_GATEWAY_PORT}`,
        );

  return new Set(
    rawOrigins
      .map((origin) => origin.trim())
      .map((origin) =>
        origin === CORS_ALLOW_ALL_ORIGINS
          ? CORS_ALLOW_ALL_ORIGINS
          : normalizeCorsOrigin(origin),
      )
      .filter((origin): origin is string => Boolean(origin)),
  );
}

export function isAllowedCorsOrigin(
  origin: string | undefined,
  allowedOrigins: Set<string> = allowedCorsOriginsFromEnv(),
  explicitOriginsConfigured = false,
): boolean {
  if (!origin) return true;
  // Loopback bypass only applies when using default (non-explicit) origins.
  // When Hiro_ALLOWED_ORIGINS is set explicitly, the configured list is authoritative.
  if (
    !explicitOriginsConfigured &&
    !allowedOrigins.has(CORS_ALLOW_ALL_ORIGINS)
  ) {
    if (isLoopbackBrowserOrigin(origin)) return true;
  }
  const normalized = normalizeCorsOrigin(origin);
  if (!normalized) return false;
  return (
    allowedOrigins.has(CORS_ALLOW_ALL_ORIGINS) || allowedOrigins.has(normalized)
  );
}

// Returns true when the user has explicitly set Hiro_ALLOWED_ORIGINS
export function hasExplicitAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env["Hiro_ALLOWED_ORIGINS"];
  return typeof raw === "string" && raw.trim().length > 0;
}

export function isWeakSecret(
  value: string | undefined,
  weakValues: string[] = [],
): boolean {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return weakValues.map((item) => item.toLowerCase()).includes(normalized);
}

export function getRequiredEnvSecret(
  name: string,
  options: RequiredSecretOptions = {},
): string {
  const value = String(process.env[name] || "").trim();
  const label = options.label || name;
  const minLength = options.minLength ?? 12;
  if (!value) {
    throw new Error(`${label} must be set.`);
  }
  if (isWeakSecret(value, options.weakValues || [])) {
    throw new Error(`${label} uses an unsafe default value.`);
  }
  if (value.length < minLength) {
    throw new Error(`${label} must be at least ${minLength} characters.`);
  }
  return value;
}

function isStrongSecret(
  value: string,
  minLength: number,
  weakValues: string[],
): boolean {
  return !isWeakSecret(value, weakValues) && value.trim().length >= minLength;
}

export function resolveLiteLLMMasterKey(
  options: ResolvedLiteLLMMasterKeyOptions = {},
): string {
  const env = options.env ?? process.env;
  const workspaceDir = options.workspaceDir?.trim();
  const filePath =
    options.filePath ||
    (workspaceDir
      ? path.join(workspaceDir, DEFAULT_LITELLM_MASTER_KEY_PATH)
      : "");
  const weakValues = options.weakValues || ["sk-anything"];
  const minLength = options.minLength ?? 12;

  const existing = String(env["LITELLM_MASTER_KEY"] || "").trim();
  if (isStrongSecret(existing, minLength, weakValues)) {
    return existing;
  }

  if (filePath) {
    try {
      const persisted = fs.readFileSync(filePath, "utf-8").trim();
      if (isStrongSecret(persisted, minLength, weakValues)) {
        env["LITELLM_MASTER_KEY"] = persisted;
        return persisted;
      }
    } catch {
      // Fall through to generation.
    }
  }

  const generated = crypto.randomBytes(32).toString("base64url");
  env["LITELLM_MASTER_KEY"] = generated;
  if (filePath) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, generated, { encoding: "utf-8", mode: 0o600 });
    } catch {
      // Ignore persistence failures and keep the in-memory key.
    }
  }
  return generated;
}

// ── CIDR validation ─────────────────────────────────────────────────────────

function ipToLong(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) + n;
  }
  return result >>> 0;
}

function parseCidr(cidr: string): { network: number; mask: number } | null {
  const parts = cidr.trim().split("/");
  if (parts.length !== 2) return null;
  const network = ipToLong(parts[0]);
  const prefix = Number(parts[1]);
  if (network === null) return null;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return { network: network & mask, mask };
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  const ipNum = ipToLong(ip);
  const parsed = parseCidr(cidr);
  if (ipNum === null || !parsed) return false;
  return (ipNum & parsed.mask) === parsed.network;
}

export function isIpAllowedByCidrs(
  ip: string,
  allowedCidrs: string[],
): boolean {
  if (allowedCidrs.length === 0) return true;
  return allowedCidrs.some((cidr) => isIpInCidr(ip, cidr));
}

export function resolveAllowedCidrsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env["Hiro_ALLOWED_CIDRS"];
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
