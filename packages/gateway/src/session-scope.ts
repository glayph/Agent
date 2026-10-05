export type SessionScope = "per-channel-peer" | "per-channel" | "per-peer" | "global";

export function normalizeSessionScope(value: unknown): SessionScope {
  switch (String(value || "per-channel-peer")) {
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
