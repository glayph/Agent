/**
 * Security helpers used by gateway and core API.
 */

import * as fs from "fs";
import * as path from "path";
import { resolveAllowedCidrsFromEnv } from "./index.js";
import { readMikiEnv as readMikiEnvValue } from "./env-compat.js";

type SecurityOptions = {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  weakValues?: readonly string[];
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
  ].find((candidate): candidate is string =>
    typeof candidate === "string" && candidate.trim().length > 0,
  );
  if (!value) {
    throw new Error(`Secret ${name} must be set`);
  }
  if (options.weakValues?.some((weakValue) => value === weakValue)) {
    throw new Error(`Secret ${name} uses unsafe default`);
  }
  return value;
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

  const raw = [
    readMikiEnvValue("MIKI_ALLOWED_ORIGINS", env),
    env.MIKI_ALLOWED_ORIGINS,
    env.Miki_ALLOWED_ORIGINS,
    env.ALLOWED_ORIGINS,
  ].find((candidate): candidate is string =>
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
  return allowed.length === 0;
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

export function isIpAllowedByCidrs(
  ip: string | undefined,
  cidrs: string[] = resolveAllowedCidrsFromEnv(),
  ..._rest: unknown[]
): boolean {
  if (!ip) return false;
  if (cidrs.length === 0) return true;
  if (isLoopbackAddress(ip)) return true;
  return cidrs.some(
    (cidr) => cidr === "*" || cidr === ip || ip.startsWith(cidr.replace(/\.0\/\d+$/, ".")),
  );
}

export { resolveAllowedCidrsFromEnv };
