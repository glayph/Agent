import { Request, Response, NextFunction } from "express";
import type { IncomingHttpHeaders } from "http";
import {
  getApiKeyAuthenticationSecrets,
  getRequiredEnvSecret,
  timingSafeStringEqual,
} from "@miki/config/security";
export {
  getSessionPermissionState,
  getSessionPermissions,
  getToolPermissionDecision,
  recordToolPermissionDenial,
  setSessionPermissions,
  isToolEnabledForSession,
} from "../mcp/permissions/session-permissions.js";

const WEAK_API_KEY_SECRETS = ["Miki-dev-key", "sk-anything"];
const API_KEY_SECRET_REQUIREMENTS = {
  weakValues: WEAK_API_KEY_SECRETS,
  minLength: 16,
  label: "API_KEY_SECRET",
} as const;

export type ApiKeyAuthResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 500;
      error: string;
      detail: string;
    };

export function isApiKeyAuthEnabled(): boolean {
  return process.env.ENABLE_API_KEY_AUTH === "true";
}

export function validateApiKeyConfiguration(): void {
  if (!isApiKeyAuthEnabled()) return;
  getRequiredApiKeySecret();
}

export function getRequiredApiKeySecret(): string {
  // Always validate the configured secret and surface any validation
  // errors to the caller. This avoids implicit auto-generation of a
  // fallback secret which would mask configuration problems when API
  // key authentication is enabled.
  return getRequiredEnvSecret("API_KEY_SECRET", API_KEY_SECRET_REQUIREMENTS);
}

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

export function apiKeyFromHeaders(headers: IncomingHttpHeaders): string {
  const header = headers["x-api-key"];
  if (Array.isArray(header)) return header[0] || "";
  if (typeof header === "string") return header;
  const authorization = firstHeaderValue(headers.authorization);
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

export function authenticateApiKeyHeaders(
  headers: IncomingHttpHeaders,
): ApiKeyAuthResult {
  let expected: string[];
  try {
    expected = getApiKeyAuthenticationSecrets();
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: "API key authentication is misconfigured",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const apiKey = apiKeyFromHeaders(headers);
  if (
    !apiKey ||
    !expected.some((candidate) => timingSafeStringEqual(apiKey, candidate))
  ) {
    return {
      ok: false,
      status: 401,
      error: "Unauthorized",
      detail: "Invalid or missing API key",
    };
  }

  return { ok: true };
}

export function isApiKeyRequestAuthenticated(
  headers: IncomingHttpHeaders,
): boolean {
  return authenticateApiKeyHeaders(headers).ok;
}

function isDashboardCompatPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Middleware to validate API key from X-API-Key header
 * Skips validation if ENABLE_API_KEY_AUTH is not set or false
 * Protects tool execution and sensitive endpoints
 */
export function validateApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!isApiKeyAuthEnabled() || isDashboardCompatPath(req.path)) {
    return next();
  }

  const auth = authenticateApiKeyHeaders(req.headers);
  if (!("status" in auth)) {
    return next();
  }

  return res.status(auth.status).json({
    error: auth.error,
    detail: auth.detail,
  });
}

export function validateRequiredApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const auth = authenticateApiKeyHeaders(req.headers);
  if (!("status" in auth)) {
    return next();
  }

  return res.status(auth.status).json({
    error: auth.error,
    detail: auth.detail,
  });
}
