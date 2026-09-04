import type { AgentOrchestrator } from "../../../agent.js";
import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { IrcBot } from "./index.js";

export const ircChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "irc",
    display_name: "IRC",
    config_key: "irc",
    runtime_status: "functional",
    runtime_note:
      "Node IRC socket adapter supports TLS/plain sockets, joins, mentions, DMs, outbound replies, and reconnect.",
    required_fields: ["server", "nick"],
    secret_fields: ["password", "nickserv_password", "sasl_password"],
    env_fields: {
      server: "IRC_SERVER",
      nick: "IRC_NICK",
      password: "IRC_PASSWORD",
    },
  }),
  createRuntime: (orchestrator: AgentOrchestrator) => new IrcBot(orchestrator),
};
