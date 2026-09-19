import type { AgentOrchestrator } from "../../../agent.js";
import { Router } from "express";
import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { TelegramBot, resolveTelegramRuntimeConfig } from "./index.js";

export const telegramChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "telegram",
    display_name: "Telegram",
    config_key: "telegram",
    runtime_status: "functional",
    runtime_note: "Telegram adapter supports durable long polling or secret-verified webhooks, canonical sessions, allowlists, rate limits, duplicate protection, threaded replies, attachments, and delivery retry.",
    required_fields: ["token"],
    secret_fields: ["token", "webhook_secret"],
    env_fields: {
      token: "TELEGRAM_BOT_TOKEN",
      webhook_secret: "TELEGRAM_WEBHOOK_SECRET",
      webhook_url: "TELEGRAM_WEBHOOK_URL",
    },
    webhook_path: "/webhooks/telegram",
  }),
  createRuntime: (orchestrator: AgentOrchestrator) =>
    new TelegramBot(orchestrator),
  createRouter: (orchestrator: AgentOrchestrator) => {
    const router = Router();
    let bot: TelegramBot | null = null;
    router.post("/", async (req, res) => {
      const configured = resolveTelegramRuntimeConfig(orchestrator.config).webhookSecret;
      if (
        configured &&
        req.header("x-telegram-bot-api-secret-token") !== configured
      ) {
        res.status(401).json({ error: "invalid Telegram webhook secret" });
        return;
      }
      try {
        bot ||= new TelegramBot(orchestrator);
        await bot.handleWebhookUpdate(req.body);
        res.sendStatus(200);
      } catch (error) {
        res
          .status(500)
          .json({ error: error instanceof Error ? error.message : String(error) });
      }
    });
    return router;
  },
};
