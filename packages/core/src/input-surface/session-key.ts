/**
 * Deterministic session_key resolution for all input surfaces.
 * Formula: surface + conversation/thread-id + agent-role
 * (Step 06 / Step 07 queue serialization key.)
 */

import type { SurfaceId } from "./types.js";

const DEFAULT_ROLE = "default";
const DEFAULT_THREAD = "main";

function normalizePart(value: string | undefined | null, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:@-]+/g, "_");
  return normalized || fallback;
}

export interface SessionKeyParts {
  surface: SurfaceId | string;
  conversationId?: string;
  threadId?: string;
  agentRole?: string;
}

/**
 * Build a deterministic session_key shared across all surfaces.
 * Prefer conversationId; fall back to threadId; then DEFAULT_THREAD.
 */
export function resolveSessionKey(parts: SessionKeyParts): string {
  const surface = normalizePart(String(parts.surface), "unknown");
  const thread = normalizePart(
    parts.conversationId ?? parts.threadId,
    DEFAULT_THREAD,
  );
  const role = normalizePart(parts.agentRole, DEFAULT_ROLE);
  return `${surface}:${thread}:${role}`;
}

/** True when value already looks like surface:thread:role (at least 3 segments). */
export function looksLikeSessionKey(value: string): boolean {
  const parts = value.split(":");
  return parts.length >= 3 && parts.every((p) => p.length > 0);
}

/**
 * Parse a session_key produced by resolveSessionKey.
 * Returns null if the shape is invalid.
 */
export function parseSessionKey(
  sessionKey: string,
): { surface: string; thread: string; role: string } | null {
  const parts = sessionKey.split(":");
  if (parts.length < 3) return null;
  const role = parts[parts.length - 1]!;
  const thread = parts[parts.length - 2]!;
  const surface = parts.slice(0, -2).join(":");
  if (!surface || !thread || !role) return null;
  return { surface, thread, role };
}
