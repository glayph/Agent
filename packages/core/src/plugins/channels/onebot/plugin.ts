import type { AgentOrchestrator } from "../../../agent.js";
import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { channelFieldValue, isValidUrlLike } from "../_shared/probe.js";
import { OneBotBot } from "./index.js";

export const onebotChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "onebot",
    display_name: "OneBot",
    config_key: "onebot",
    runtime_status: "functional",
    runtime_note:
      "Node OneBot v11 adapter supports WebSocket inbound events, HTTP replies, filtering, mentions, and reconnect.",
    required_fields: ["server_url"],
    secret_fields: ["access_token"],
    env_fields: {
      server_url: "ONEBOT_SERVER_URL",
      access_token: "ONEBOT_ACCESS_TOKEN",
    },
    probe_config: (config) => [
      {
        id: "server_url_shape",
        status: isValidUrlLike(channelFieldValue(config, "server_url"), [
          "http:",
          "https:",
          "ws:",
          "wss:",
        ])
          ? "pass"
          : "fail",
        message: "OneBot server URL must use http(s):// or ws(s)://.",
      },
    ],
  }),
  createRuntime: (orchestrator: AgentOrchestrator) =>
    new OneBotBot(orchestrator),
};
