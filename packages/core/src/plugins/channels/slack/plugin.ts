import type { AgentOrchestrator } from "../../../agent.js";
import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { SlackBot } from "./index.js";

export const slackChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "slack",
    display_name: "Slack",
    config_key: "slack",
    runtime_status: "functional",
    runtime_note:
      "Node Slack Socket Mode adapter supports events, acknowledgements, threaded replies, filtering, reconnect, and API error surfacing.",
    required_fields: ["bot_token", "app_token"],
    secret_fields: ["bot_token", "app_token", "signing_secret"],
    env_fields: {
      bot_token: "SLACK_BOT_TOKEN",
      app_token: "SLACK_APP_TOKEN",
      signing_secret: "SLACK_SIGNING_SECRET",
    },
  }),
  createRuntime: (orchestrator: AgentOrchestrator) =>
    new SlackBot(orchestrator),
};
