import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";

export const weixinChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "weixin",
    display_name: "WeChat",
    config_key: "weixin",
    runtime_status: "partial",
    runtime_note:
      "QR binding is available, but no production inbound/outbound WeChat adapter is mounted in the Node runtime.",
    required_fields: ["account_id"],
    secret_fields: ["token", "encoding_aes_key"],
    env_fields: {
      account_id: "WEIXIN_ACCOUNT_ID",
      token: "WEIXIN_TOKEN",
      encoding_aes_key: "WEIXIN_ENCODING_AES_KEY",
    },
  }),
};
