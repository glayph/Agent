import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";

export const mikiChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "miki",
    display_name: "miki",
    config_key: "miki",
    runtime_status: "functional",
    runtime_note:
      "Verified WebUI chat path through the gateway WebSocket proxy.",
    required_fields: ["token"],
    secret_fields: ["token"],
    env_fields: { token: "MIKI_TOKEN" },
  }),
};
