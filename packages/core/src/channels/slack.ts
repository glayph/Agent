import WebSocket from "ws";
import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "./agent-response.js";

const SLACK_API_BASE = "https://slack.com/api";
const SLACK_MESSAGE_LIMIT = 3000;

type JsonRecord = Record<string, unknown>;

export interface SlackRuntimeConfig {
  enabled: boolean;
  botToken: string;
  appToken: string;
  allowedIds: string[];
  reconnect: boolean;
}

export interface SlackEvent {
  type?: string;
  subtype?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  team?: string;
  ts?: string;
  thread_ts?: string;
}

interface SlackEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: {
    event?: SlackEvent;
    team_id?: string;
  };
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  url?: string;
  user_id?: string;
  bot_id?: string;
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

export function resolveSlackRuntimeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): SlackRuntimeConfig {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = recordOrEmpty(channels.slack);
  const settings = recordOrEmpty(raw.settings);
  const botToken = stringOrEmpty(
    env.SLACK_BOT_TOKEN ?? settings.bot_token ?? raw.bot_token,
  );
  const appToken = stringOrEmpty(
    env.SLACK_APP_TOKEN ?? settings.app_token ?? raw.app_token,
  );

  return {
    enabled:
      raw.enabled === true &&
      botToken.length > 0 &&
      appToken.length > 0 &&
      env.ENABLE_SLACK !== "false",
    botToken,
    appToken,
    allowedIds: stringArray(settings.allow_from ?? raw.allow_from),
    reconnect: raw.reconnect !== false,
  };
}

export function shouldHandleSlackEvent(
  event: SlackEvent,
  botUserId: string | null,
  config: SlackRuntimeConfig,
): boolean {
  const text = stringOrEmpty(event.text);
  if (!event.channel || !event.user || !text) return false;
  if (event.bot_id || event.subtype) return false;
  if (botUserId && event.user === botUserId) return false;

  if (config.allowedIds.length > 0) {
    const allowed = new Set(config.allowedIds);
    const matched =
      allowed.has(event.user) ||
      allowed.has(event.channel) ||
      (event.team ? allowed.has(event.team) : false);
    if (!matched) return false;
  }

  if (event.channel_type === "im") return true;
  if (event.type === "app_mention") return true;
  return Boolean(botUserId && text.includes(`<@${botUserId}>`));
}

export function normalizeSlackPrompt(
  text: string,
  botUserId: string | null,
): string {
  let prompt = text;
  if (botUserId) {
    prompt = prompt.replace(new RegExp(`<@${botUserId}>`, "g"), "");
  }
  return prompt
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export class SlackBot {
  private readonly orchestrator: AgentOrchestrator;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private stopping = false;
  private started = false;
  private botUserId: string | null = null;
  private runtimeConfig: SlackRuntimeConfig | null = null;

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
  }

  start(): void {
    if (this.started) return;
    const config = resolveSlackRuntimeConfig(this.orchestrator.config);
    this.runtimeConfig = config;
    if (!config.enabled) {
      if (!config.botToken || !config.appToken) {
        console.log(
          "Slack bot disabled: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not configured",
        );
      } else if (process.env["ENABLE_SLACK"] === "false") {
        console.log("Slack bot disabled via ENABLE_SLACK=false");
      } else {
        console.log("Slack bot disabled in channel configuration");
      }
      return;
    }

    this.started = true;
    this.stopping = false;
    this.connect().catch((err) => {
      console.warn(
        `Slack Socket Mode startup failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.scheduleReconnect();
    });
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
        // Ignore close failures during shutdown.
      }
      this.ws = null;
    }
  }

  private async connect(): Promise<void> {
    const config = this.runtimeConfig;
    if (!config?.enabled || this.stopping) return;
    this.botUserId ||= await this.fetchBotUserId(config.botToken);
    const url = await this.openSocketUrl(config.appToken);
    if (this.stopping || !this.started) return;

    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      this.reconnectAttempts = 0;
      console.log("Slack Socket Mode connected");
    });
    ws.on("message", (data) => {
      this.handleSocketMessage(data.toString()).catch((err) => {
        console.warn(
          `Slack Socket Mode message handling failed: ${
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
      console.warn(`Slack Socket Mode error: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping || !this.started) return;
    this.reconnectAttempts += 1;
    const delayMs = Math.min(60_000, 1_000 * 2 ** this.reconnectAttempts);
    console.log(
      `Slack Socket Mode reconnect attempt ${this.reconnectAttempts} in ${delayMs}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        console.warn(
          `Slack Socket Mode reconnect failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async handleSocketMessage(raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as SlackEnvelope;
    if (envelope.envelope_id) {
      this.ws?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    const event = envelope.payload?.event;
    if (envelope.type !== "events_api" || !event) return;
    await this.handleEvent(event, envelope.payload?.team_id);
  }

  private async handleEvent(event: SlackEvent, teamId?: string): Promise<void> {
    const config = this.runtimeConfig;
    if (!config || !shouldHandleSlackEvent(event, this.botUserId, config)) {
      return;
    }
    const prompt = normalizeSlackPrompt(event.text || "", this.botUserId);
    if (!prompt || !event.channel) return;

    const sessionId = [
      "slack",
      teamId || event.team || "workspace",
      event.channel,
      event.user || "unknown",
    ].join("_");
    const response = await collectAgentResponse(
      this.orchestrator,
      sessionId,
      prompt,
    );
    for (const part of splitOutboundMessage(response, SLACK_MESSAGE_LIMIT)) {
      await this.postMessage(event.channel, part, event.thread_ts || event.ts);
    }
  }

  private async openSocketUrl(appToken: string): Promise<string> {
    const body = await this.slackRequest<SlackApiResponse>(
      "/apps.connections.open",
      appToken,
      {},
    );
    if (!body.url) {
      throw new Error("Slack did not return a Socket Mode URL");
    }
    return body.url;
  }

  private async fetchBotUserId(botToken: string): Promise<string | null> {
    const body = await this.slackRequest<SlackApiResponse>(
      "/auth.test",
      botToken,
      {},
    );
    return body.user_id || null;
  }

  private async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<void> {
    const token = this.runtimeConfig?.botToken;
    if (!token) return;
    await this.slackRequest<SlackApiResponse>("/chat.postMessage", token, {
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  private async slackRequest<T extends SlackApiResponse>(
    path: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${SLACK_API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => ({}))) as T;
    if (!res.ok || payload.ok === false) {
      throw new Error(
        `Slack API ${path} failed: ${res.status} ${payload.error || res.statusText}`,
      );
    }
    return payload;
  }
}
