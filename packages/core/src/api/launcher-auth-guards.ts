import * as crypto from "crypto";

export interface StoredAuth {
  password_hash?: string;
  salt?: string;
  created_at?: string;
  updated_at?: string;
}

export function isAuthInitialized(auth?: StoredAuth): boolean {
  return Boolean(auth?.password_hash && auth.salt);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function canRunDashboardSetup(
  auth: StoredAuth | undefined,
  authenticated: boolean,
): boolean {
  return !isAuthInitialized(auth) || authenticated;
}

export type DashboardAccessDecision =
  "allow" | "uninitialized" | "unauthorized";

export function dashboardAccessDecision(
  auth: StoredAuth | undefined,
  authenticated: boolean,
): DashboardAccessDecision {
  if (authenticated) return "allow";
  return isAuthInitialized(auth) ? "unauthorized" : "uninitialized";
}

export function validateOneTimeBootstrapToken(
  suppliedToken: string,
  expectedToken: string | undefined,
  consumedTokens: Set<string>,
): boolean {
  const expected = String(expectedToken || "").trim();
  if (!expected || consumedTokens.has(expected)) return false;
  if (!timingSafeStringEqual(suppliedToken, expected)) return false;
  consumedTokens.add(expected);
  return true;
}
