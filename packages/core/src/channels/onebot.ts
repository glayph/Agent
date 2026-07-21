import WebSocket from "ws";
import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "./agent-response.js";

const ONEBOT_MESSAGE_LIMIT = 3500;

type JsonRecord = Record<string, unknown>;

export interface OneBotRuntimeConfig {
  enabled: boolean;
  serverUrl: string;
  accessToken: string;
  botId: string;
  allowedIds: string[];
  mentionOnly: boolean;
  triggerPrefixes: string[];
  reconnect: boolean;
}

export interface OneBotMessageEvent {
  post_type?: string;
  message_type?: "private" | "group" | string;
  sub_type?: string;
  self_id?: number | string;
  user_id?: number | string;
  group_id?: number | string;
  message?: unknown;
  raw_message?: string;
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function idOrEmpty(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return stringOrEmpty(value);
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

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeServerUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString().replace(/\/+$/g, "");
    }
    if (url.protocol === "ws:" || url.protocol === "wss:") {
      return url.toString().replace(/\/+$/g, "");
    }
  } catch {
    return raw.replace(/\/+$/g, "");
  }
  return raw.replace(/\/+$/g, "");
}

function websocketUrlFromServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (!url.pathname || url.pathname === "/") url.pathname = "/";
  return url.toString();
}

function httpUrlFromServerUrl(serverUrl: string, endpoint: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = `${url.pathname.replace(/\/+$/g, "")}/${endpoint.replace(/^\/+/g, "")}`;
  url.search = "";
  return url.toString();
}

function messageToText(message: unknown, rawMessage?: string): string {
  if (typeof rawMessage === "string" && rawMessage.trim()) {
    return rawMessage.trim();
  }
  if (typeof message === "string") return message.trim();
  if (Array.isArray(message)) {
    return message
      .map((segment) => {
        if (typeof segment === "string") return segment;
        const item = recordOrEmpty(segment);
        const type = stringOrEmpty(item.type);
        const data = recordOrEmpty(item.data);
        if (type === "text") return stringOrEmpty(data.text);
        if (type === "at") return `[CQ:at,qq=${stringOrEmpty(data.qq)}]`;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function allowedIdMatches(
  allowedIds: string[],
  event: OneBotMessageEvent,
): boolean {
  if (allowedIds.length === 0) return true;
  const userId = idOrEmpty(event.user_id);
  const groupId = idOrEmpty(event.group_id);
  const allowed = new Set(allowedIds);
  return (
    (userId && (allowed.has(userId) || allowed.has(`user:${userId}`))) ||
    (groupId && (allowed.has(groupId) || allowed.has(`group:${groupId}`))) ||
    (event.message_type ? allowed.has(event.message_type) : false)
  );
}

function hasOneBotMention(text: string, botId: string): boolean {
  if (!botId) return false;
  return (
    text.includes(`[CQ:at,qq=${botId}]`) ||
    text.includes(`[CQ:at,qq=all]`) ||
    text.includes(`@${botId}`)
  );
}

export function resolveOneBotRuntimeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): OneBotRuntimeConfig {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = recordOrEmpty(channels.onebot);
  const settings = recordOrEmpty(raw.settings);
  const groupTrigger = recordOrEmpty(
    settings.group_trigger ?? raw.group_trigger,
  );
  const serverUrl = normalizeServerUrl(
    stringOrEmpty(
      env.ONEBOT_SERVER_URL ?? settings.server_url ?? raw.server_url,
    ),
  );
  const accessToken = stringOrEmpty(
    env.ONEBOT_ACCESS_TOKEN ?? settings.access_token ?? raw.access_token,
  );
  const botId = idOrEmpty(env.ONEBOT_BOT_ID ?? settings.bot_id ?? raw.bot_id);

  return {
    enabled:
      raw.enabled === true &&
      serverUrl.length > 0 &&
      env.ENABLE_ONEBOT !== "false",
    serverUrl,
    accessToken,
    botId,
    allowedIds: stringArray(settings.allow_from ?? raw.allow_from),
    mentionOnly: boolValue(groupTrigger.mention_only, true),
    triggerPrefixes: stringArray(groupTrigger.prefixes),
    reconnect: raw.reconnect !== false,
  };
}

export function shouldHandleOneBotEvent(
  event: OneBotMessageEvent,
  config: OneBotRuntimeConfig,
): boolean {
  if (event.post_type !== "message") return false;
  if (event.message_type !== "private" && event.message_type !== "group") {
    return false;
  }
  const userId = idOrEmpty(event.user_id);
  if (!userId) return false;
  const selfId = idOrEmpty(event.self_id);
  if (selfId && userId === selfId) return false;
  const text = messageToText(event.message, event.raw_message);
  if (!text) return false;
  if (!allowedIdMatches(config.allowedIds, event)) return false;
  if (event.message_type === "private") return true;
  if (!config.mentionOnly) return true;
  if (hasOneBotMention(text, config.botId || selfId)) return true;
  return config.triggerPrefixes.some((prefix) => text.startsWith(prefix));
}

export function normalizeOneBotPrompt(
  event: OneBotMessageEvent,
  config: Pick<OneBotRuntimeConfig, "botId" | "triggerPrefixes">,
): string {
  const text = messageToText(event.message, event.raw_message);
  const mentionId = config.botId || idOrEmpty(event.self_id);
  let prompt = text
    .replace(/\[CQ:at,qq=all\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (mentionId) {
    prompt = prompt
      .replace(new RegExp(`\\[CQ:at,qq=${mentionId}\\]`, "g"), "")
      .replace(new RegExp(`@${mentionId}\\b`, "g"), "")
      .replace(/\s+/g, " ")
      .trim();
  }
  for (const prefix of config.triggerPrefixes) {
    if (prefix && prompt.startsWith(prefix)) {
      prompt = prompt.slice(prefix.length).trim();
      break;
    }
  }
  return prompt;
}

export class OneBotBot {
  private readonly orchestrator: AgentOrchestrator;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private stopping = false;
  private started = false;
  private runtimeConfig: OneBotRuntimeConfig | null = null;

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
  }

  start(): void {
    if (this.started) return;
    const config = resolveOneBotRuntimeConfig(this.orchestrator.config);
    this.runtimeConfig = config;
    if (!config.enabled) {
      if (!config.serverUrl) {
        console.log("OneBot disabled: ONEBOT_SERVER_URL not configured");
      } else if (process.env["ENABLE_ONEBOT"] === "false") {
        console.log("OneBot disabled via ENABLE_ONEBOT=false");
      } else {
        console.log("OneBot disabled in channel configuration");
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "shutdown");
      } catch {
        // Ignore shutdown close errors.
      }
      this.ws = null;
    }
  }

  private connect(): void {
    const config = this.runtimeConfig;
    if (!config?.enabled || this.stopping) return;

    try {
      const headers: Record<string, string> = {};
      if (config.accessToken) {
        headers.Authorization = `Bearer ${config.accessToken}`;
      }
      const ws = new WebSocket(websocketUrlFromServerUrl(config.serverUrl), {
        headers,
      });
      this.ws = ws;
      ws.on("open", () => {
        this.reconnectAttempts = 0;
        console.log("OneBot WebSocket connected");
      });
      ws.on("message", (data) => {
        this.handleSocketMessage(data.toString()).catch((err) => {
          console.warn(
            `OneBot message handling failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      });
      ws.on("close", () => {
        this.ws = null;
        if (!this.stopping && this.started && config.reconnect) {
          this.scheduleReconnect();
        }
      });
      ws.on("error", (err) => {
        console.warn(`OneBot WebSocket error: ${err.message}`);
      });
    } catch (err) {
      console.warn(
        `OneBot WebSocket connection failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping || !this.started) return;
    this.reconnectAttempts += 1;
    const delayMs = Math.min(60_000, 1_000 * 2 ** this.reconnectAttempts);
    console.log(
      `OneBot reconnect attempt ${this.reconnectAttempts} in ${delayMs}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async handleSocketMessage(raw: string): Promise<void> {
    const event = JSON.parse(raw) as OneBotMessageEvent;
    const config = this.runtimeConfig;
    if (!config || !shouldHandleOneBotEvent(event, config)) return;

    const prompt = normalizeOneBotPrompt(event, config);
    if (!prompt) return;

    const sessionId = [
      "onebot",
      event.message_type,
      idOrEmpty(event.group_id) || "dm",
      idOrEmpty(event.user_id) || "unknown",
    ].join("_");

    const response = await collectAgentResponse(
      this.orchestrator,
      sessionId,
      prompt,
    );
    for (const part of splitOutboundMessage(response, ONEBOT_MESSAGE_LIMIT)) {
      await this.sendMessage(event, part, config);
    }
  }

  private async sendMessage(
    event: OneBotMessageEvent,
    message: string,
    config: OneBotRuntimeConfig,
  ): Promise<void> {
    const isGroup = event.message_type === "group";
    const endpoint = isGroup ? "send_group_msg" : "send_private_msg";
    const payload = isGroup
      ? { group_id: event.group_id, message }
      : { user_id: event.user_id, message };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.accessToken) {
      headers.Authorization = `Bearer ${config.accessToken}`;
    }
    const res = await fetch(httpUrlFromServerUrl(config.serverUrl, endpoint), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `OneBot ${endpoint} failed: ${res.status} ${body.slice(0, 200)}`,
      );
    }
  }
}
