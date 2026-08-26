import type { AgentOrchestrator } from "../../../agent.js";
import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { TelegramBot } from "./index.js";

export const telegramChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "telegram",
    display_name: "Telegram",
    config_key: "telegram",
    runtime_status: "functional",
    runtime_note: "Node Telegram adapter exists; requires a valid bot token.",
    required_fields: ["token"],
    secret_fields: ["token"],
    env_fields: { token: "TELEGRAM_BOT_TOKEN" },
  }),
  createRuntime: (orchestrator: AgentOrchestrator) =>
    new TelegramBot(orchestrator),
};
