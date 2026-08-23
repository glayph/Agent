import { Telegraf, type Context } from "telegraf";
import type { Agent as HttpAgent } from "node:http";
import HttpsProxyAgent from "https-proxy-agent";
import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  streamAgentResponse,
  splitOutboundMessageForOrchestrator,
} from "./agent-response.js";
import { resolveChannelSessionId } from "./session-scope.js";
import { runWithCallContext } from "../tools/executor/call-context.js";
import { VoiceInputRouter } from "../voice-routing.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const TELEGRAM_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TELEGRAM_AUDIO_MIME_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
]);

type JsonRecord = Record<string, unknown>;

export interface TelegramRuntimeConfig {
  enabled: boolean;
  token: string;
  apiRoot: string;
  proxy: string;
  allowedIds: string[];
  adminIds: string[];
  typing: boolean;
  streaming: { enabled: boolean; throttleMs: number; minGrowthChars: number };
  placeholder: { enabled: boolean; text: string };
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
  const record = message as Record<string, unknown>;
  const candidate = record.text ?? record.caption;
  return typeof candidate === "string" ? candidate.trim() : "";
}

interface TelegramAudioReference {
  fileId: string;
  filename: string;
  mimeType: string;
  durationMs?: number;
}

function extractTelegramAudio(message: unknown): TelegramAudioReference | null {
  const record = recordOrEmpty(message);
  const voice = recordOrEmpty(record.voice);
  const audio = recordOrEmpty(record.audio);
  const document = recordOrEmpty(record.document);
  const candidate =
    Object.keys(voice).length > 0
      ? voice
      : Object.keys(audio).length > 0
        ? audio
        : String(document.mime_type || "")
              .toLowerCase()
              .startsWith("audio/")
          ? document
          : null;
  if (!candidate) return null;
  const fileId = stringOrEmpty(candidate.file_id);
  if (!fileId) return null;
  const rawMime = stringOrEmpty(candidate.mime_type)
    .split(";", 1)[0]
    .toLowerCase();
  const mimeType =
    rawMime || (Object.keys(voice).length > 0 ? "audio/ogg" : "");
  if (!TELEGRAM_AUDIO_MIME_TYPES.has(mimeType)) {
    throw new Error("Telegram voice format is not supported.");
  }
  const duration = Number(candidate.duration);
  const durationMs =
    Number.isFinite(duration) && duration >= 0
      ? Math.min(Math.round(duration * 1000), 5 * 60 * 1000)
      : undefined;
  const filename = stringOrEmpty(candidate.file_name) || `${fileId}.audio`;
  return {
    fileId,
    filename,
    mimeType,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

async function downloadTelegramAudio(
  ctx: TelegramContext,
  reference: TelegramAudioReference,
): Promise<Buffer> {
  const link = await ctx.telegram.getFileLink(reference.fileId);
  const response = await fetch(String(link), {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Telegram audio download failed with HTTP ${response.status}.`,
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > TELEGRAM_MAX_AUDIO_BYTES
  ) {
    throw new Error("Telegram voice message exceeds the 25 MB limit.");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > TELEGRAM_MAX_AUDIO_BYTES) {
        throw new Error("Telegram voice message exceeds the 25 MB limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("Telegram voice message was empty.");
  return Buffer.concat(chunks, total);
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
      stringOrEmpty(
        env.TELEGRAM_API_ROOT ??
          settings.api_root ??
          settings.base_url ??
          raw.api_root ??
          raw.base_url,
      ),
    ),
    proxy: stringOrEmpty(env.TELEGRAM_PROXY ?? settings.proxy ?? raw.proxy),
    allowedIds: stringArray(settings.allow_from ?? raw.allow_from),
    adminIds: stringArray(settings.admin_allow_from ?? raw.admin_allow_from),
    typing: booleanOrDefault(
      typeof settings.typing === "object"
        ? recordOrEmpty(settings.typing).enabled
        : (settings.typing ?? raw.typing),
      true,
    ),
    streaming: {
      enabled: booleanOrDefault(
        recordOrEmpty(settings.streaming ?? raw.streaming).enabled,
        false,
      ),
      throttleMs: Math.max(
        250,
        Number(
          recordOrEmpty(settings.streaming ?? raw.streaming).throttle_seconds ??
            1,
        ) * 1000,
      ),
      minGrowthChars: Math.max(
        1,
        Number(
          recordOrEmpty(settings.streaming ?? raw.streaming).min_growth_chars ??
            20,
        ),
      ),
    },
    placeholder: {
      enabled: booleanOrDefault(
        recordOrEmpty(settings.placeholder ?? raw.placeholder).enabled,
        false,
      ),
      text:
        stringOrEmpty(
          recordOrEmpty(settings.placeholder ?? raw.placeholder).text,
        ) || "Miki is thinking…",
    },
    reconnect: raw.reconnect !== false,
  };
}

export function shouldHandleTelegramMessage(
  ctx: TelegramContext,
  config: TelegramRuntimeConfig,
): boolean {
  if (!ctx.chat || !ctx.from || ctx.from.is_bot === true) return false;
  const text = extractTelegramText(ctx.message);
  const hasAudio = Boolean(extractTelegramAudio(ctx.message));
  if ((!text && !hasAudio) || (text && text.startsWith("/"))) return false;

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

export function isTelegramAdmin(
  ctx: TelegramContext,
  config: TelegramRuntimeConfig,
): boolean {
  if (
    !ctx.chat ||
    !ctx.from ||
    ctx.from.is_bot === true ||
    config.adminIds.length === 0
  ) {
    return false;
  }
  const allowed = new Set(config.adminIds);
  return (
    allowed.has(toStringId(ctx.from.id)) ||
    allowed.has(toStringId(ctx.chat.id)) ||
    (ctx.from.username ? allowed.has(ctx.from.username) : false)
  );
}

export function parseTelegramAdminCommand(
  message: string,
): { action: "approvals" | "approve" | "deny"; requestId?: string } | null {
  const match = message
    .trim()
    .match(
      /^\/(?:miki\s+)?(approvals?|approve|deny)(?:\s+([A-Fa-f0-9-]{16,128}))?\s*$/i,
    );
  if (!match) return null;
  const action = match[1].toLowerCase();
  if (action === "approval" || action === "approvals")
    return { action: "approvals" };
  if (!match[2]) return null;
  return { action: action as "approve" | "deny", requestId: match[2] };
}

export class TelegramBot {
  private readonly orchestrator: AgentOrchestrator;
  private bot: Telegraf<TelegramContext> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private stopping = false;
  private started = false;
  private runtimeConfig: TelegramRuntimeConfig | null = null;
  private readonly voiceRouter: VoiceInputRouter;
  private launchInProgress = false;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly RECONNECT_BASE_MS = 2000;

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
    this.voiceRouter = new VoiceInputRouter(orchestrator.runtimePaths);
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
      telegram: {
        apiRoot: config.apiRoot,
        ...(config.proxy
          ? {
              agent: HttpsProxyAgent(config.proxy) as unknown as HttpAgent,
            }
          : {}),
      },
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
      if (!config) return;

      const message = extractTelegramText(ctx.message);
      if (!message) return;
      if (await this.handleAdminCommand(ctx, config, message)) return;
      if (!shouldHandleTelegramMessage(ctx, config)) return;

      try {
        if (config.typing) {
          await ctx.sendChatAction("typing");
        }
        const placeholder = config.placeholder.enabled
          ? await ctx.reply(config.placeholder.text)
          : null;
        await runWithCallContext(
          {
            origin: "remote",
            source: "telegram",
            actor: `telegram:${toStringId(ctx.from?.id) || "unknown"}`,
          },
          async () => {
            let response = "";
            if (config.streaming.enabled && placeholder) {
              let lastEdit = 0;
              let lastLength = 0;
              await streamAgentResponse(
                this.orchestrator,
                resolveChannelSessionId(
                  this.orchestrator.config,
                  "telegram",
                  toStringId(ctx.from?.id),
                  toStringId(ctx.chat.id),
                ),
                message,
                async (delta) => {
                  response += delta;
                  const now = Date.now();
                  if (
                    response.length - lastLength <
                      config.streaming.minGrowthChars &&
                    now - lastEdit < config.streaming.throttleMs
                  ) {
                    return;
                  }
                  lastEdit = now;
                  lastLength = response.length;
                  try {
                    await ctx.telegram.editMessageText(
                      ctx.chat.id,
                      placeholder.message_id,
                      undefined,
                      response.slice(0, TELEGRAM_MESSAGE_LIMIT),
                    );
                  } catch {
                    // Telegram may reject an edit when the text is unchanged.
                  }
                },
              ).then((full) => {
                response = full;
              });
              if (response) {
                try {
                  await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    placeholder.message_id,
                    undefined,
                    response.slice(0, TELEGRAM_MESSAGE_LIMIT),
                  );
                } catch {
                  await ctx.reply(response);
                }
                for (const part of splitOutboundMessageForOrchestrator(
                  this.orchestrator,
                  response.slice(TELEGRAM_MESSAGE_LIMIT),
                  TELEGRAM_MESSAGE_LIMIT,
                )) {
                  if (part) await ctx.reply(part);
                }
              }
            } else {
              response = await collectAgentResponse(
                this.orchestrator,
                resolveChannelSessionId(
                  this.orchestrator.config,
                  "telegram",
                  toStringId(ctx.from?.id),
                  toStringId(ctx.chat.id),
                ),
                message,
              );
              if (placeholder) {
                try {
                  await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    placeholder.message_id,
                    undefined,
                    response.slice(0, TELEGRAM_MESSAGE_LIMIT),
                  );
                  response = response.slice(TELEGRAM_MESSAGE_LIMIT);
                } catch {
                  // Fall through to normal replies if the placeholder cannot be edited.
                }
              }
              const parts = splitOutboundMessageForOrchestrator(
                this.orchestrator,
                response,
                TELEGRAM_MESSAGE_LIMIT,
              );
              for (const part of parts) {
                if (part) await ctx.reply(part);
              }
            }
          },
        );
      } catch (err: unknown) {
        await ctx.reply(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    this.bot.on(["voice", "audio", "document"], async (ctx) => {
      const config = this.runtimeConfig;
      if (!config || !shouldHandleTelegramMessage(ctx, config)) return;
      const reference = extractTelegramAudio(ctx.message);
      if (!reference) return;
      try {
        if (config.typing) await ctx.sendChatAction("typing");
        const data = await downloadTelegramAudio(ctx, reference);
        const routed = await this.voiceRouter.route(
          {
            data,
            filename: reference.filename,
            mimeType: reference.mimeType,
            ...(reference.durationMs !== undefined
              ? { clientDurationMs: reference.durationMs }
              : {}),
          },
          this.orchestrator.modelName,
        );
        const sessionId = resolveChannelSessionId(
          this.orchestrator.config,
          "telegram",
          toStringId(ctx.from?.id),
          toStringId(ctx.chat?.id),
        );
        const caption = extractTelegramText(ctx.message);
        const message =
          routed.mode === "local"
            ? routed.transcript.transcript.trim()
            : caption || "Please process this voice message.";
        if (!message && routed.mode === "local") {
          await ctx.reply("No speech was detected in the voice message.");
          return;
        }
        const response = await collectAgentResponse(
          this.orchestrator,
          sessionId,
          message,
          TELEGRAM_MESSAGE_LIMIT * 3,
          {
            voice: {
              source: "channel",
              provider: routed.voice.provider,
              language: routed.voice.language,
              transcript: routed.mode === "local" ? message : "",
              ...(routed.voice.durationMs !== undefined
                ? { duration_ms: routed.voice.durationMs }
                : {}),
              ...(routed.mode === "local"
                ? {
                    latency_ms: routed.transcript.latency_ms,
                    transport: routed.voice.transport,
                  }
                : {
                    model: routed.model,
                    transport: "cloud" as const,
                  }),
            },
            ...(routed.mode === "cloud" ? { audio: routed.audio } : {}),
          },
        );
        for (const part of splitOutboundMessageForOrchestrator(
          this.orchestrator,
          response,
          TELEGRAM_MESSAGE_LIMIT,
        )) {
          if (part) await ctx.reply(part);
        }
      } catch (err: unknown) {
        await ctx.reply(
          `Voice message error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  private async handleAdminCommand(
    ctx: TelegramContext,
    config: TelegramRuntimeConfig,
    message: string,
  ): Promise<boolean> {
    const command = parseTelegramAdminCommand(message);
    if (!command) return false;
    if (!isTelegramAdmin(ctx, config)) {
      await ctx.reply(
        "This Telegram identity is not authorized for Agent administration.",
      );
      return true;
    }
    const inbox = this.orchestrator.tools.approvalInbox;
    if (!inbox) {
      await ctx.reply("The Agent approval service is not initialized.");
      return true;
    }
    const actor = `telegram:${toStringId(ctx.from?.id) || "unknown"}`;
    try {
      await runWithCallContext(
        { origin: "remote", source: "telegram", actor },
        async () => {
          if (command.action === "approvals") {
            const pending = inbox.list({ status: "pending" });
            if (pending.length === 0) {
              await ctx.reply("No pending Agent approval requests.");
              return;
            }
            const lines = pending
              .slice(0, 20)
              .map(
                (request) =>
                  `${request.id}\n${request.action} | ${request.resource} | ${request.risk}\n${request.reason}\nExpires: ${request.expiresAt}`,
              );
            await ctx.reply(
              `Pending approvals (max 20):\n\n${lines.join("\n\n")}`.slice(
                0,
                TELEGRAM_MESSAGE_LIMIT,
              ),
            );
            return;
          }
          const requestId = command.requestId!;
          const decided =
            command.action === "approve"
              ? inbox.approveByOperator(
                  requestId,
                  actor,
                  "approved by Telegram allow-listed owner",
                )
              : inbox.denyByOperator(
                  requestId,
                  actor,
                  "denied by Telegram allow-listed owner",
                );
          await ctx.reply(
            `${command.action === "approve" ? "Approved" : "Denied"}: ${decided.id}`,
          );
        },
      );
    } catch (err: unknown) {
      await ctx.reply(
        `Approval command failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
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
