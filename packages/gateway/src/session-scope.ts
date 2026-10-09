export type SessionScope = "per-channel-peer" | "per-channel" | "per-peer" | "global";

/**
 * Conversation scope. Every chat (web chat session, Telegram chat, ...) is its own
 * conversation by default, so each task keeps its own history and the user can see
 * what was started when and why. Long-term memory is NOT scoped by this setting: it
 * is one global store shared by every channel (see @miki/core/memory).
 */
export function normalizeSessionScope(value: unknown): SessionScope {
  switch (String(value ?? "").trim()) {
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
