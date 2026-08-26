import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { channelFieldValue, isValidUrlLike } from "../_shared/probe.js";
import { createWhatsAppBridgeRouter } from "./index.js";

export const whatsappChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "whatsapp",
    display_name: "WhatsApp",
    config_key: "whatsapp",
    runtime_status: "functional",
    runtime_note:
      "Node WhatsApp bridge adapter verifies shared tokens, parses common bridge payloads, filters events, and sends bounded outbound replies.",
    required_fields: ["bridge_url"],
    secret_fields: ["webhook_token"],
    env_fields: {
      bridge_url: "WHATSAPP_BRIDGE_URL",
      webhook_token: "WHATSAPP_WEBHOOK_TOKEN",
    },
    webhook_path: "/webhooks/whatsapp",
    probe_config: (config) => [
      {
        id: "bridge_url_shape",
        status: isValidUrlLike(channelFieldValue(config, "bridge_url"), [
          "http:",
          "https:",
        ])
          ? "pass"
          : "fail",
        message: "WhatsApp bridge URL must use http:// or https://.",
      },
    ],
  }),
  createRouter: createWhatsAppBridgeRouter,
};
