import type { AgentOrchestrator } from "../../../agent.js";
import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { DiscordBot } from "./index.js";

export const discordChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "discord",
    display_name: "Discord",
    config_key: "discord",
    runtime_status: "functional",
    runtime_note:
      "Node Discord Gateway adapter supports inbound messages, outbound replies, filtering, reconnect, and API error surfacing.",
    required_fields: ["token"],
    secret_fields: ["token"],
    env_fields: { token: "DISCORD_BOT_TOKEN" },
  }),
  createRuntime: (orchestrator: AgentOrchestrator) =>
    new DiscordBot(orchestrator),
};
