import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { createLineWebhookRouter } from "./index.js";

export const lineChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "line",
    display_name: "LINE",
    config_key: "line",
    runtime_status: "functional",
    runtime_note:
      "Node LINE webhook adapter verifies signatures, filters events, and sends bounded replies.",
    required_fields: ["token", "channel_secret"],
    secret_fields: ["token", "channel_secret"],
    env_fields: {
      token: "LINE_CHANNEL_ACCESS_TOKEN",
      channel_secret: "LINE_CHANNEL_SECRET",
    },
    webhook_path: "/webhooks/line",
  }),
  createRouter: createLineWebhookRouter,
};
