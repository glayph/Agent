import { UNIVERSAL_SESSION_ID } from "../universal-session.js";

type JsonRecord = Record<string, unknown>;

export type SessionScope =
  "per-channel-peer" | "per-channel" | "per-peer" | "global";

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function normalizePart(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._:@-]+/g, "_");
  return normalized || fallback;
}

export function resolveSessionScope(
  config: Record<string, unknown>,
): SessionScope {
  const session = recordOrEmpty(config.session);
  const value = session.dm_scope;
  if (
    value === "per-channel" ||
    value === "per-peer" ||
    value === "global" ||
    value === "per-channel-peer"
  ) {
    return value;
  }
  return "per-channel-peer";
}

export function resolveChannelSessionId(
  config: Record<string, unknown>,
  channel: string,
  peer: string,
  room?: string,
): string {
  const scope = resolveSessionScope(config);
  if (scope === "global") return UNIVERSAL_SESSION_ID;

  const channelPart = normalizePart(channel, "channel");
  const peerPart = normalizePart(peer, "peer");
  const roomPart = normalizePart(room || peer, peerPart);
  if (scope === "per-channel") return `channel:${channelPart}`;
  if (scope === "per-peer") return `peer:${peerPart}`;
  return `channel:${channelPart}:peer:${roomPart}`;
}
