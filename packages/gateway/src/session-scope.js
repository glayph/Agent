export function normalizeSessionScope(value) {
    switch (String(value || "per-channel-peer")) {
        case "global": return "global";
        case "per-channel": return "per-channel";
        case "per-peer": return "per-peer";
        default: return "per-channel-peer";
    }
}
export function resolveSessionContextId(scope, channelId, peerId) {
    switch (normalizeSessionScope(scope)) {
        case "global": return "miki-global";
        case "per-channel": return `channel:${channelId}`;
        case "per-peer": return `peer:${peerId}`;
        default: return `channel:${channelId}:peer:${peerId}`;
    }
}
