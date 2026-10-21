/** Shared channel configuration schema used by the gateway and dashboard UI. */
export type ChannelRuntimeStatus = "functional" | "partial" | "config_only";

export interface ChannelConfigMetadata {
  displayName: string;
  requiredFields: readonly string[];
  secretFields: readonly string[];
  runtimeStatus: ChannelRuntimeStatus;
  note: string;
}

export const CHANNEL_CONFIG_METADATA: Record<string, ChannelConfigMetadata> = {
  telegram: { displayName: "Telegram", requiredFields: ["token"], secretFields: ["token"], runtimeStatus: "functional", note: "Live Bot API long-polling adapter is hosted by the gateway; set allow_from to trusted sender IDs before enabling it." },
  discord: { displayName: "Discord", requiredFields: ["token"], secretFields: ["token"], runtimeStatus: "functional", note: "Live Discord Gateway adapter is hosted by the gateway; enable Message Content intent and set allow_from to trusted sender IDs." },
  slack: { displayName: "Slack", requiredFields: ["bot_token", "app_token"], secretFields: ["bot_token", "app_token"], runtimeStatus: "functional", note: "Live Socket Mode adapter is hosted by the gateway; subscribe to message events and set allow_from to trusted sender IDs." },
  feishu: { displayName: "Feishu", requiredFields: ["app_id", "app_secret"], secretFields: ["app_secret", "encrypt_key", "verification_token"], runtimeStatus: "partial", note: "Configuration and validation are managed by the dashboard." },
  dingtalk: { displayName: "DingTalk", requiredFields: ["webhook_url"], secretFields: ["webhook_url", "client_secret"], runtimeStatus: "partial", note: "Configuration and webhook validation are managed by the dashboard." },
  line: { displayName: "LINE", requiredFields: ["token", "channel_secret"], secretFields: ["token", "channel_secret", "channel_access_token"], runtimeStatus: "partial", note: "Configuration is managed by the dashboard." },
  qq: { displayName: "QQ", requiredFields: ["bot_id", "token"], secretFields: ["token"], runtimeStatus: "partial", note: "Configuration is managed by the dashboard." },
  onebot: { displayName: "OneBot", requiredFields: ["server_url"], secretFields: ["access_token"], runtimeStatus: "partial", note: "Configuration is managed by the dashboard." },
  weixin: { displayName: "Weixin", requiredFields: ["account_id"], secretFields: ["token", "encoding_aes_key"], runtimeStatus: "partial", note: "QR binding is managed by the persistent gateway; live message transport remains adapter-owned." },
  wecom: { displayName: "WeCom", requiredFields: ["bot_id", "secret"], secretFields: ["secret", "corp_secret", "webhook_url"], runtimeStatus: "partial", note: "QR binding is managed by the persistent gateway; live message transport remains adapter-owned." },
  whatsapp: { displayName: "WhatsApp", requiredFields: ["bridge_url"], secretFields: ["webhook_token"], runtimeStatus: "config_only", note: "Bridge configuration is persisted; no persistent WhatsApp adapter is hosted here." },
  whatsapp_native: { displayName: "WhatsApp Native", requiredFields: ["config"], secretFields: [], runtimeStatus: "config_only", note: "Native connection configuration is persisted; live adapter is not hosted here." },
  miki: { displayName: "Miki", requiredFields: ["token"], secretFields: ["token"], runtimeStatus: "functional", note: "Built-in Miki WebSocket channel is hosted by the persistent gateway." },
  matrix: { displayName: "Matrix", requiredFields: ["homeserver_url", "user_id", "access_token"], secretFields: ["access_token"], runtimeStatus: "partial", note: "Configuration is managed by the dashboard." },
  irc: { displayName: "IRC", requiredFields: ["server", "nick"], secretFields: ["password", "nickserv_password", "sasl_password"], runtimeStatus: "partial", note: "Configuration is managed by the dashboard." },
  mqtt: { displayName: "MQTT", requiredFields: ["broker", "agent_id"], secretFields: ["username", "password"], runtimeStatus: "partial", note: "Configuration and broker validation are managed by the dashboard." },
};

/** Field-to-temporary-input mapping used by channel forms. */
export const CHANNEL_SECRET_FIELD_MAP: Record<string, string> = {
  token: "_token", app_secret: "_app_secret", client_secret: "_client_secret",
  corp_secret: "_corp_secret", channel_secret: "_channel_secret",
  channel_access_token: "_channel_access_token", access_token: "_access_token",
  webhook_token: "_webhook_token", webhook_url: "_webhook_url",
  bot_token: "_bot_token", app_token: "_app_token", encoding_aes_key: "_encoding_aes_key",
  encrypt_key: "_encrypt_key", verification_token: "_verification_token",
  secret: "_secret", username: "_username", password: "_password",
  nickserv_password: "_nickserv_password", sasl_password: "_sasl_password",
};

export const CHANNEL_REQUIRED_FIELDS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(CHANNEL_CONFIG_METADATA).map(([name, meta]) => [name, meta.requiredFields]),
);
export const CHANNEL_SECRET_FIELDS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(CHANNEL_CONFIG_METADATA).map(([name, meta]) => [name, meta.secretFields]),
);
export const CHANNEL_SECRET_FIELD_KEYS: readonly string[] = Object.keys(CHANNEL_SECRET_FIELD_MAP);
