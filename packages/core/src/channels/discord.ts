import WebSocket from "ws";
import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "./agent-response.js";

const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_MESSAGE_LIMIT = 1900;
const DISCORD_INTENTS =
  (1 << 9) | // GuildMessages
  (1 << 12) | // DirectMessages
  (1 << 15); // MessageContent

type JsonRecord = Record<string, unknown>;

interface DiscordAuthor {
  id: string;
  bot?: boolean;
  username?: string;
}

interface DiscordMention {
  id: string;
}

interface DiscordMessageCreate {
  id: string;
  content?: string;
  channel_id: string;
  guild_id?: string;
  author?: DiscordAuthor;
  mentions?: DiscordMention[];
}

interface DiscordGatewayPayload {
  op: number;
  s?: number | null;
  t?: string | null;
  d?: unknown;
}

export interface DiscordRuntimeConfig {
  enabled: boolean;
  token: string;
  allowedIds: string[];
  mentionOnly: boolean;
  triggerPrefixes: string[];
  reconnect: boolean;
}

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

export function resolveDiscordRuntimeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): DiscordRuntimeConfig {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = recordOrEmpty(channels.discord);
  const settings = recordOrEmpty(raw.settings);
  const groupTrigger = recordOrEmpty(
    settings.group_trigger ?? raw.group_trigger,
  );
  const token = stringOrEmpty(
    env.DISCORD_BOT_TOKEN ?? settings.token ?? raw.token,
  );

  return {
    enabled:
      raw.enabled === true &&
      token.length > 0 &&
      env.ENABLE_DISCORD !== "false",
    token,
    allowedIds: stringArray(settings.allow_from ?? raw.allow_from),
    mentionOnly: groupTrigger.mention_only !== false,
    triggerPrefixes: stringArray(groupTrigger.prefixes),
    reconnect: raw.reconnect !== false,
  };
}

export function shouldHandleDiscordMessage(
  message: DiscordMessageCreate,
  botUserId: string | null,
  config: DiscordRuntimeConfig,
): boolean {
  if (!message.author?.id || message.author.bot === true) return false;
  const content = stringOrEmpty(message.content);
  if (!content) return false;

  if (config.allowedIds.length > 0) {
    const allowed = new Set(config.allowedIds);
    const matched =
      allowed.has(message.author.id) ||
      allowed.has(message.channel_id) ||
      (message.guild_id ? allowed.has(message.guild_id) : false);
    if (!matched) return false;
  }

  if (!message.guild_id) return true;
  if (!botUserId) return !config.mentionOnly;
  const mentioned =
    content.includes(`<@${botUserId}>`) ||
    content.includes(`<@!${botUserId}>`) ||
    (message.mentions || []).some((mention) => mention.id === botUserId);
  const prefixMatched =
    config.triggerPrefixes.length > 0 &&
    config.triggerPrefixes.some((prefix) => content.startsWith(prefix));
  return !config.mentionOnly || mentioned || prefixMatched;
}

export function normalizeDiscordPrompt(
  content: string,
  botUserId: string | null,
  prefixes: string[] = [],
): string {
  let prompt = content;
  if (botUserId) {
    prompt = prompt
      .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
      .replace(/\s+/g, " ");
  }
  prompt = prompt.trim();
  for (const prefix of prefixes) {
    if (prefix && prompt.startsWith(prefix)) {
      prompt = prompt.slice(prefix.length);
      break;
    }
  }
  return prompt.trim();
}

export class DiscordBot {
  private readonly orchestrator: AgentOrchestrator;
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private stopping = false;
  private started = false;
  private botUserId: string | null = null;
  private runtimeConfig: DiscordRuntimeConfig | null = null;

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
  }

  start(): void {
    if (this.started) return;
    const config = resolveDiscordRuntimeConfig(this.orchestrator.config);
    this.runtimeConfig = config;
    if (!config.enabled) {
      if (!config.token) {
        console.log("Discord bot disabled: DISCORD_BOT_TOKEN not configured");
      } else if (process.env["ENABLE_DISCORD"] === "false") {
        console.log("Discord bot disabled via ENABLE_DISCORD=false");
      } else {
        console.log("Discord bot disabled in channel configuration");
      }
      return;
    }

    this.started = true;
    this.stopping = false;
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "shutdown");
      } catch {
        // Ignore close failures during shutdown.
      }
      this.ws = null;
    }
  }

  private connect(): void {
    const config = this.runtimeConfig;
    if (!config?.enabled || this.stopping) return;

    try {
      const ws = new WebSocket(DISCORD_GATEWAY_URL);
      this.ws = ws;
      ws.on("open", () => {
        this.reconnectAttempts = 0;
        console.log("Discord gateway connected");
      });
      ws.on("message", (data) => {
        this.handleGatewayData(data.toString()).catch((err) => {
          console.warn(
            `Discord gateway message handling failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      });
      ws.on("close", (code) => {
        this.clearHeartbeat();
        this.ws = null;
        if (!this.stopping && this.started && config.reconnect) {
          this.scheduleReconnect(code);
        }
      });
      ws.on("error", (err) => {
        console.warn(`Discord gateway error: ${err.message}`);
      });
    } catch (err) {
      console.warn(
        `Discord gateway connection failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.scheduleReconnect(0);
    }
  }

  private async handleGatewayData(raw: string): Promise<void> {
    const payload = JSON.parse(raw) as DiscordGatewayPayload;
    if (typeof payload.s === "number") this.seq = payload.s;

    if (payload.op === 10) {
      const hello = recordOrEmpty(payload.d);
      const interval =
        typeof hello.heartbeat_interval === "number"
          ? hello.heartbeat_interval
          : 45_000;
      this.startHeartbeat(interval);
      this.identify();
      return;
    }

    if (payload.op === 7) {
      this.reconnectNow();
      return;
    }

    if (payload.op === 9) {
      this.reconnectNow();
      return;
    }

    if (payload.t === "READY") {
      const ready = recordOrEmpty(payload.d);
      const user = recordOrEmpty(ready.user);
      this.botUserId = stringOrEmpty(user.id) || null;
      console.log("Discord bot ready");
      return;
    }

    if (payload.t === "MESSAGE_CREATE") {
      await this.handleMessageCreate(payload.d as DiscordMessageCreate);
    }
  }

  private identify(): void {
    const token = this.runtimeConfig?.token;
    if (!token || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token,
          intents: DISCORD_INTENTS,
          properties: {
            os: process.platform,
            browser: "Hiro",
            device: "Hiro",
          },
        },
      }),
    );
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    const sendHeartbeat = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
    };
    sendHeartbeat();
    this.heartbeatTimer = setInterval(sendHeartbeat, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private reconnectNow(): void {
    if (this.ws) {
      try {
        this.ws.close(4000, "reconnect");
      } catch {
        this.scheduleReconnect(0);
      }
    } else {
      this.scheduleReconnect(0);
    }
  }

  private scheduleReconnect(closeCode: number): void {
    if (this.reconnectTimer || this.stopping || !this.started) return;
    if (closeCode === 4004 || closeCode === 4010 || closeCode === 4011) {
      console.warn(`Discord gateway closed permanently with code ${closeCode}`);
      this.stop();
      return;
    }
    this.reconnectAttempts += 1;
    const delayMs = Math.min(60_000, 1_000 * 2 ** this.reconnectAttempts);
    console.log(
      `Discord gateway reconnect attempt ${this.reconnectAttempts} in ${delayMs}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async handleMessageCreate(
    message: DiscordMessageCreate,
  ): Promise<void> {
    const config = this.runtimeConfig;
    if (
      !config ||
      !shouldHandleDiscordMessage(message, this.botUserId, config)
    ) {
      return;
    }
    const prompt = normalizeDiscordPrompt(
      message.content || "",
      this.botUserId,
      config.triggerPrefixes,
    );
    if (!prompt) return;

    const sessionId = [
      "discord",
      message.guild_id || "dm",
      message.channel_id,
      message.author?.id || "unknown",
    ].join("_");

    await this.postTyping(message.channel_id);
    const response = await collectAgentResponse(
      this.orchestrator,
      sessionId,
      prompt,
    );
    for (const part of splitOutboundMessage(response, DISCORD_MESSAGE_LIMIT)) {
      await this.postMessage(message.channel_id, part);
    }
  }

  private async postTyping(channelId: string): Promise<void> {
    await this.discordRequest(`/channels/${channelId}/typing`, {
      method: "POST",
    });
  }

  private async postMessage(channelId: string, content: string): Promise<void> {
    await this.discordRequest(`/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  }

  private async discordRequest(
    path: string,
    init: RequestInit = {},
  ): Promise<void> {
    const token = this.runtimeConfig?.token;
    if (!token) return;
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bot ${token}`);
    headers.set("User-Agent", "Hiro Agent (https://Hiro.local, 1.0)");
    const res = await fetch(`${DISCORD_API_BASE}${path}`, {
      ...init,
      headers,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Discord API ${path} failed: ${res.status} ${res.statusText}${
          body ? ` ${body.slice(0, 300)}` : ""
        }`,
      );
    }
  }
}
