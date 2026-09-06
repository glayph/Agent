import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { channelFieldValue, isNonEmptyIdentifier } from "../_shared/probe.js";
import { createFeishuWebhookRouter } from "./index.js";

export const feishuChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "feishu",
    display_name: "Feishu",
    config_key: "feishu",
    runtime_status: "functional",
    runtime_note:
      "Node Feishu/Lark webhook adapter supports token-verified callbacks, URL verification, inbound text events, bounded replies, filtering, and API error surfacing.",
    required_fields: ["app_id", "app_secret"],
    secret_fields: ["app_secret", "encrypt_key", "verification_token"],
    env_fields: {
      app_id: "FEISHU_APP_ID",
      app_secret: "FEISHU_APP_SECRET",
      encrypt_key: "FEISHU_ENCRYPT_KEY",
      verification_token: "FEISHU_VERIFICATION_TOKEN",
    },
    webhook_path: "/webhooks/feishu",
    probe_config: (config) => [
      {
        id: "app_id_shape",
        status: isNonEmptyIdentifier(channelFieldValue(config, "app_id"))
          ? "pass"
          : "fail",
        message: "Feishu app_id must be a non-empty application identifier.",
      },
    ],
  }),
  createRouter: createFeishuWebhookRouter,
};
