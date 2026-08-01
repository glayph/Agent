import { Telegraf, type Context } from "telegraf";
import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "./agent-response.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;

type JsonRecord = Record<string, unknown>;

export interface TelegramRuntimeConfig {
  enabled: boolean;
  token: string;
  apiRoot: string;
  allowedIds: string[];
  typing: boolean;
  reconnect: boolean;
}

type TelegramContext = Context;

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringOrEmpty).filter(Boolean)
    : typeof value === "string" && value.trim()
      ? value
          .split(/\r?\n|,/)
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  if (value === true || value === false) return value;
  return fallback;
}

function normalizeApiRoot(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "https://api.telegram.org";
  return trimmed.replace(/\/+$/g, "");
}

function toStringId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return stringOrEmpty(value);
}

function extractTelegramText(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "";
  }
  const candidate = (message as Record<string, unknown>).text;
  return typeof candidate === "string" ? candidate.trim() : "";
}

export function resolveTelegramRuntimeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): TelegramRuntimeConfig {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = recordOrEmpty(channels.telegram);
  const settings = recordOrEmpty(raw.settings);
  const token = stringOrEmpty(
    env.TELEGRAM_BOT_TOKEN ?? settings.token ?? raw.token,
  );

  return {
    enabled:
      raw.enabled === true &&
      token.length > 0 &&
      env.ENABLE_TELEGRAM !== "false",
    token,
    apiRoot: normalizeApiRoot(
      stringOrEmpty(env.TELEGRAM_API_ROOT ?? settings.api_root ?? raw.api_root),
    ),
    allowedIds: stringArray(settings.allow_from ?? raw.allow_from),
    typing: booleanOrDefault(settings.typing ?? raw.typing, true),
    reconnect: raw.reconnect !== false,
  };
}

export function shouldHandleTelegramMessage(
  ctx: TelegramContext,
  config: TelegramRuntimeConfig,
): boolean {
  if (!ctx.chat || !ctx.from || ctx.from.is_bot === true) return false;
  const text = extractTelegramText(ctx.message);
  if (!text || text.startsWith("/")) return false;

  if (config.allowedIds.length > 0) {
    const allowed = new Set(config.allowedIds);
    const matched =
      allowed.has(toStringId(ctx.from.id)) ||
      allowed.has(toStringId(ctx.chat.id)) ||
      (ctx.from.username ? allowed.has(ctx.from.username) : false);
    if (!matched) return false;
  }

  return true;
}

function telegramSessionId(ctx: TelegramContext): string {
  return [
    "telegram",
    ctx.chat?.type || "chat",
    toStringId(ctx.chat?.id),
    toStringId(ctx.from?.id),
  ].join("_");
}

export class TelegramBot {
  private readonly orchestrator: AgentOrchestrator;
  private bot: Telegraf<TelegramContext> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private stopping = false;
  private started = false;
  private runtimeConfig: TelegramRuntimeConfig | null = null;
  private launchInProgress = false;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly RECONNECT_BASE_MS = 2000;

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
  }

  start(): void {
    if (this.started) return;
    const config = resolveTelegramRuntimeConfig(this.orchestrator.config);
    this.runtimeConfig = config;
    if (!config.enabled) {
      if (!config.token) {
        console.warn(
          "TELEGRAM_BOT_TOKEN not configured - Telegram channel disabled",
        );
      } else if (process.env["ENABLE_TELEGRAM"] === "false") {
        console.warn("Telegram channel disabled via ENABLE_TELEGRAM=false");
      } else {
        console.warn("Telegram channel disabled in channel configuration");
      }
      return;
    }

    this.bot = new Telegraf<TelegramContext>(config.token, {
      telegram: { apiRoot: config.apiRoot },
    });
    this.setupHandlers();

    this.started = true;
    this.stopping = false;
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.bot) {
      try {
        this.bot.stop();
      } catch {
        // Ignore shutdown failures.
      }
      this.bot = null;
    }
  }

  private setupHandlers(): void {
    if (!this.bot) return;

    this.bot.catch((err: unknown) => {
      console.error("Telegram channel polling error:", err);
      if (this._is409Conflict(err)) {
        console.warn(
          "Telegram channel: another instance is already running with this token. Disabling for this session.",
        );
        this.stop();
        return;
      }
      this.stop();
      this.scheduleReconnect();
    });

    this.bot.on("text", async (ctx) => {
      const config = this.runtimeConfig;
      if (!config || !shouldHandleTelegramMessage(ctx, config)) return;

      const message = extractTelegramText(ctx.message);
      if (!message) return;

      try {
        if (config.typing) {
          await ctx.sendChatAction("typing");
        }
        const response = await collectAgentResponse(
          this.orchestrator,
          telegramSessionId(ctx),
          message,
        );
        const parts = splitOutboundMessage(response, TELEGRAM_MESSAGE_LIMIT);
        for (const part of parts) {
          await ctx.reply(part);
        }
      } catch (err: unknown) {
        await ctx.reply(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  private connect(): void {
    if (!this.bot || !this.runtimeConfig?.enabled || this.stopping) return;
    this.launch().catch((err) => {
      console.warn(
        `Telegram channel startup failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.scheduleReconnect();
    });
  }

  private async launch(): Promise<void> {
    if (!this.bot || this.launchInProgress) return;
    this.launchInProgress = true;

    try {
      try {
        this.bot.stop();
      } catch {
        // Ignore "Bot is not running!" errors during restart.
      }

      const startupTimeoutMs = 15_000;
      await Promise.race([
        this.bot.launch(),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error("Telegram bot launch timeout")),
            startupTimeoutMs,
          ),
        ),
      ]);

      this.reconnectAttempts = 0;
      console.log("Telegram channel started in polling mode");
    } catch (err) {
      if (this._is409Conflict(err)) {
        console.warn(
          "Telegram channel: another instance is already running with this token. Disabling for this session.",
        );
        this.stop();
        return;
      }
      throw err;
    } finally {
      this.launchInProgress = false;
    }
  }

  private _is409Conflict(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      "response" in err &&
      typeof (err as { response?: unknown }).response === "object" &&
      (err as { response?: { error_code?: number } }).response !== null &&
      (err as { response?: { error_code?: number } }).response?.error_code ===
        409
    );
  }

  private scheduleReconnect(additionalDelayMs = 0): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error("Telegram channel max reconnect attempts reached");
      return;
    }
    if (!this.runtimeConfig?.reconnect) return;
    this.reconnectAttempts++;
    const backoffMs =
      Math.pow(2, this.reconnectAttempts) * this.RECONNECT_BASE_MS;
    const jitter = backoffMs / 2 + Math.random() * (backoffMs / 2);
    const totalDelay = Math.round(jitter + additionalDelayMs);
    console.log(
      `Telegram channel reconnect attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} in ${totalDelay}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.launch().catch((err) => {
        console.warn(
          `Telegram channel reconnect failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        this.scheduleReconnect();
      });
    }, totalDelay);
    this.reconnectTimer.unref?.();
  }
}
