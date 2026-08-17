/**
 * Security helpers used by gateway and core API.
 */

import { readMikiEnv, resolveAllowedCidrsFromEnv } from "./index.js";

export function getRequiredEnvSecret(
  name: string,
  ..._rest: unknown[]
): string {
  const v =
    process.env[name] ||
    process.env[`MIKI_${name}`] ||
    readMikiEnv(name);
  if (!v) throw new Error(`Required secret/env missing: ${name}`);
  return v;
}

export function normalizeCorsOrigin(origin: string): string {
  return origin.replace(/\/$/, "").toLowerCase();
}

export function allowedCorsOriginsFromEnv(
  _opts?: { workspaceDir?: string } | unknown
): string[] {
  const raw =
    readMikiEnv("CORS_ORIGINS") ||
    process.env.MIKI_CORS_ORIGINS ||
    process.env.CORS_ORIGINS ||
    "";
  if (!raw.trim()) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => normalizeCorsOrigin(s.trim()))
    .filter(Boolean);
}

export function hasExplicitAllowedOrigins(
  _opts?: unknown
): boolean {
  return allowedCorsOriginsFromEnv().length > 0;
}

/** Accepts 1–3 args as used by gateway */
export function isAllowedCorsOrigin(
  origin: string | undefined,
  _allowed?: string[] | boolean | unknown,
  _explicit?: boolean | unknown
): boolean {
  if (!origin) return true;
  const allowed = Array.isArray(_allowed)
    ? (_allowed as string[])
    : allowedCorsOriginsFromEnv();
  if (allowed.length === 0) return true;
  const n = normalizeCorsOrigin(origin);
  return allowed.some((a) => a === n || a === "*");
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "localhost" ||
    addr.startsWith("127.")
  );
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
    (c) => c === "*" || c === ip || ip.startsWith(c.replace(/\.0\/\d+$/, "."))
  );
}

export { resolveAllowedCidrsFromEnv };
