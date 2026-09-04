/**
 * Security helpers used by gateway and core API.
 */

import * as crypto from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { isIP } from "node:net";
import { resolveAllowedCidrsFromEnv } from "./index.js";
import { readMikiEnv as readMikiEnvValue } from "./env-compat.js";

type SecurityOptions = {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  weakValues?: readonly string[];
  minLength?: number;
};

function securityOptions(value: unknown): SecurityOptions {
  if (!value || typeof value !== "object") return {};
  return value as SecurityOptions;
}

function environmentFor(value: unknown): NodeJS.ProcessEnv {
  const options = securityOptions(value);
  if (options.env) return options.env;
  if (
    value &&
    typeof value === "object" &&
    !("env" in options) &&
    !("workspaceDir" in options) &&
    !("weakValues" in options)
  ) {
    return value as NodeJS.ProcessEnv;
  }
  return process.env;
}

export function getRequiredEnvSecret(
  name: string,
  optionsValue?: SecurityOptions,
): string {
  const options = securityOptions(optionsValue);
  const env = environmentFor(optionsValue);
  const canonicalName = name.startsWith("MIKI_") ? name : `MIKI_${name}`;
  const value = [
    env[name],
    env[canonicalName],
    readMikiEnvValue(canonicalName, env),
  ].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  if (!value) {
    throw new Error(`Secret ${name} must be set`);
  }
  if (options.weakValues?.some((weakValue) => value === weakValue)) {
    throw new Error(`Secret ${name} uses unsafe default`);
  }
  if (options.minLength && value.length < options.minLength) {
    throw new Error(
      `Secret ${name} must be at least ${options.minLength} characters`,
    );
  }
  return value;
}

const API_KEY_SECRET_REQUIREMENTS = {
  weakValues: ["Miki-dev-key", "sk-anything"],
  minLength: 16,
} as const;

export function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  const length = Math.max(left.length, right.length);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  const equal = crypto.timingSafeEqual(paddedLeft, paddedRight);
  return equal && left.length === right.length;
}

export function getApiKeyAuthenticationSecrets(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const current = getRequiredEnvSecret("API_KEY_SECRET", {
    env,
    ...API_KEY_SECRET_REQUIREMENTS,
  });
  const previous = [
    env.API_KEY_SECRET_PREVIOUS,
    env.MIKI_API_KEY_SECRET_PREVIOUS,
  ]
    .find((value): value is string => Boolean(value?.trim()))
    ?.trim();
  if (!previous) return [current];
  if (
    API_KEY_SECRET_REQUIREMENTS.weakValues.some(
      (weakValue) => weakValue === previous,
    )
  ) {
    throw new Error("Secret API_KEY_SECRET_PREVIOUS uses unsafe default");
  }
  if (previous.length < API_KEY_SECRET_REQUIREMENTS.minLength) {
    throw new Error(
      `Secret API_KEY_SECRET_PREVIOUS must be at least ${API_KEY_SECRET_REQUIREMENTS.minLength} characters`,
    );
  }
  return timingSafeStringEqual(previous, current)
    ? [current]
    : [current, previous];
}

export function assertPublicBindPolicy(
  host: string,
  options: {
    env?: NodeJS.ProcessEnv;
    allowedCidrs?: string[];
    allowedOrigins?: string[];
    label?: string;
    allowEnvVar?: string;
  } = {},
): void {
  const normalizedHost = host.trim().toLowerCase();
  if (isLoopbackAddress(normalizedHost)) return;

  const env = options.env || process.env;
  const label = options.label || "service";
  const allowEnvVar = options.allowEnvVar || "MIKI_ALLOW_PUBLIC_BIND";
  const legacyAllowEnvVar = allowEnvVar.replace(/^MIKI_/, "Miki_");
  const allowPublic =
    env[allowEnvVar] === "true" || env[legacyAllowEnvVar] === "true";
  if (!allowPublic) {
    throw new Error(
      `Refusing non-loopback ${label} without ${allowEnvVar}=true`,
    );
  }

  const cidrs = normalizeAllowedCidrs(
    options.allowedCidrs || resolveAllowedCidrsFromEnv(),
  );
  if (
    cidrs.length === 0 ||
    cidrs.some(
      (cidr) => cidr === "*" || !isValidCidr(cidr) || isBroadCidr(cidr),
    )
  ) {
    throw new Error(
      `Refusing public ${label} bind without valid, restricted MIKI_ALLOWED_CIDRS`,
    );
  }

  const origins = (options.allowedOrigins || []).filter(Boolean);
  if (
    origins.length === 0 ||
    origins.some((origin) => origin === "*" || !isBrowserOrigin(origin))
  ) {
    throw new Error(
      `Refusing public ${label} bind without explicit, valid MIKI_ALLOWED_ORIGINS`,
    );
  }
}

function isBroadCidr(value: string): boolean {
  const parsed = parseCidr(value);
  return !parsed || parsed.prefix === 0;
}

export function normalizeCorsOrigin(origin: string): string {
  return origin.trim().replace(/\/$/, "").toLowerCase();
}

function hasWorkspaceBypass(workspaceDir?: string): boolean {
  if (!workspaceDir) return false;
  const configPath = path.join(workspaceDir, "config", "agent.yaml");
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return /^\s*bypass_restrictions:\s*true\s*$/m.test(content);
  } catch {
    return false;
  }
}

export function allowedCorsOriginsFromEnv(
  optionsValue?: SecurityOptions | NodeJS.ProcessEnv,
): string[] {
  const options = securityOptions(optionsValue);
  const env = environmentFor(optionsValue);
  if (hasWorkspaceBypass(options.workspaceDir)) return ["*"];

  const raw =
    [
      readMikiEnvValue("MIKI_ALLOWED_ORIGINS", env),
      env.MIKI_ALLOWED_ORIGINS,
      env.Miki_ALLOWED_ORIGINS,
      env.ALLOWED_ORIGINS,
    ].find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    ) ?? "";
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((origin) => normalizeCorsOrigin(origin))
    .filter(Boolean);
}

export function hasExplicitAllowedOrigins(
  optionsValue?: SecurityOptions | NodeJS.ProcessEnv,
): boolean {
  return allowedCorsOriginsFromEnv(optionsValue).length > 0;
}

function isBrowserOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname
      .toLowerCase()
      .replace(/^\[/, "")
      .replace(/\]$/, "");
    return isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

/** Accepts 1–3 args as used by gateway */
export function isAllowedCorsOrigin(
  origin: string | undefined,
  allowedValue?: string[] | boolean | unknown,
  explicitValue?: boolean | unknown,
): boolean {
  if (!origin) return true;
  if (!isBrowserOrigin(origin)) return false;

  const allowed = Array.isArray(allowedValue)
    ? allowedValue.map((value) => normalizeCorsOrigin(String(value)))
    : allowedCorsOriginsFromEnv();
  const normalizedOrigin = normalizeCorsOrigin(origin);
  const explicitlyConfigured = explicitValue === true;

  if (allowed.some((value) => value === "*")) return true;
  if (allowed.some((value) => value === normalizedOrigin)) return true;
  if (!explicitlyConfigured && isLoopbackOrigin(origin)) return true;
  return !explicitlyConfigured && allowed.length === 0;
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const normalized = addr.trim().toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  ) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackAddress(normalized.slice("::ffff:".length));
  }
  return false;
}

type ParsedIp = { version: 4 | 6; value: bigint };

function parseIp(value: string): ParsedIp | undefined {
  const input = value.trim().replace(/^\[|\]$/g, "");
  const version = isIP(input);
  if (version === 4) {
    const octets = input.split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some(
        (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
      )
    ) {
      return undefined;
    }
    return {
      version: 4,
      value: octets.reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n),
    };
  }
  if (version !== 6) return undefined;

  const [address, dottedTail] = input.includes(".")
    ? [
        input.slice(0, input.lastIndexOf(":")),
        input.slice(input.lastIndexOf(":") + 1),
      ]
    : [input, undefined];
  const groups = address.split("::");
  if (groups.length > 2) return undefined;
  const left = groups[0] ? groups[0].split(":") : [];
  const right = groups[1] ? groups[1].split(":") : [];
  const tail = dottedTail ? dottedTail.split(".").map(Number) : [];
  if (tail.length > 0) {
    if (
      tail.length !== 4 ||
      tail.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    )
      return undefined;
    right.push(
      ((tail[0] << 8) | tail[1]).toString(16),
      ((tail[2] << 8) | tail[3]).toString(16),
    );
  }
  const parseGroup = (group: string) =>
    /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : undefined;
  const leftValues = left.map(parseGroup);
  const rightValues = right.map(parseGroup);
  if (
    leftValues.some((value) => value === undefined) ||
    rightValues.some((value) => value === undefined)
  )
    return undefined;
  const expanded =
    groups.length === 2
      ? [
          ...leftValues,
          ...Array(8 - leftValues.length - rightValues.length).fill(0),
          ...rightValues,
        ]
      : [...leftValues, ...rightValues];
  if (expanded.length !== 8) return undefined;
  return {
    version: 6,
    value: expanded.reduce(
      (acc, group) => (acc << 16n) | BigInt(group as number),
      0n,
    ),
  };
}

function parseCidr(
  value: string,
): { ip: ParsedIp; prefix: number } | undefined {
  const trimmed = value.trim();
  if (trimmed === "*") return undefined;
  const slash = trimmed.indexOf("/");
  const address = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const ip = parseIp(address);
  if (!ip) return undefined;
  const bits = ip.version === 4 ? 32 : 128;
  const prefix = slash === -1 ? bits : Number(trimmed.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits)
    return undefined;
  return { ip, prefix };
}

export function isValidCidr(value: string): boolean {
  return value.trim() === "*" || Boolean(parseCidr(value));
}

export function normalizeAllowedCidrs(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isIpAllowedByCidrs(
  ip: string | undefined,
  cidrs: string[] = resolveAllowedCidrsFromEnv(),
  ..._rest: unknown[]
): boolean {
  const parsedIp = ip ? parseIp(ip) : undefined;
  if (!parsedIp) return false;
  const configured = normalizeAllowedCidrs(cidrs);
  if (configured.length === 0) return true;
  return configured.some((candidate) => {
    if (candidate === "*") return true;
    const parsed = parseCidr(candidate);
    if (!parsed || parsed.ip.version !== parsedIp.version) return false;
    const bits = parsed.ip.version === 4 ? 32n : 128n;
    const mask =
      parsed.prefix === 0
        ? 0n
        : ((1n << bits) - 1n) ^ ((1n << (bits - BigInt(parsed.prefix))) - 1n);
    return (parsed.ip.value & mask) === (parsedIp.value & mask);
  });
}

export { resolveAllowedCidrsFromEnv };
