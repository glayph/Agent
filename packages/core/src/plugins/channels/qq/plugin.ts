import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { channelFieldValue } from "../_shared/probe.js";
import { createQqWebhookRouter } from "./index.js";

export const qqChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "qq",
    display_name: "QQ",
    config_key: "qq",
    runtime_status: "functional",
    runtime_note:
      "Node QQ webhook adapter supports inbound message callbacks, bounded outbound replies, filtering, and API error surfacing.",
    required_fields: ["bot_id", "token"],
    secret_fields: ["token"],
    env_fields: { bot_id: "QQ_BOT_ID", token: "QQ_BOT_TOKEN" },
    webhook_path: "/webhooks/qq",
    probe_config: (config) => [
      {
        id: "bot_id_shape",
        status:
          typeof channelFieldValue(config, "bot_id") === "string" &&
          /^\d{5,20}$/.test(String(channelFieldValue(config, "bot_id")).trim())
            ? "pass"
            : "fail",
        message: "QQ bot_id must be a 5-20 digit bot account ID.",
      },
    ],
  }),
  createRouter: createQqWebhookRouter,
};
