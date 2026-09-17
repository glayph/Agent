import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";

export const wecomChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "wecom",
    display_name: "WeCom",
    config_key: "wecom",
    runtime_status: "partial",
    runtime_note:
      "QR binding is available, but no production inbound/outbound WeCom adapter is mounted in the Node runtime.",
    required_fields: ["bot_id"],
    secret_fields: ["secret", "corp_secret", "webhook_url"],
    env_fields: {
      bot_id: "WECOM_BOT_ID",
      secret: "WECOM_SECRET",
      corp_secret: "WECOM_CORP_SECRET",
      webhook_url: "WECOM_WEBHOOK_URL",
    },
  }),
};
