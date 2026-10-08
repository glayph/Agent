export type SessionScope = "per-channel-peer" | "per-channel" | "per-peer" | "global";

/**
 * Unset means "global": one shared conversation across every channel and peer,
 * so earlier work is never lost when the user switches channel. An explicit but
 * unrecognised value falls back to the most isolated mode, never to a wider one.
 */
export function normalizeSessionScope(value: unknown): SessionScope {
  const raw = String(value ?? "").trim();
  if (!raw) return "global";
  switch (raw) {
    case "global": return "global";
    case "per-channel": return "per-channel";
    case "per-peer": return "per-peer";
    default: return "per-channel-peer";
  }
}

export function resolveSessionContextId(scope: unknown, channelId: string, peerId: string): string {
  switch (normalizeSessionScope(scope)) {
    case "global": return "miki-global";
    case "per-channel": return `channel:${channelId}`;
    case "per-peer": return `peer:${peerId}`;
    default: return `channel:${channelId}:peer:${peerId}`;
  }
}
