import { Router, type Request, type Response } from "express";
import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "./agent-response.js";

const QQ_API_BASE = "https://api.sgroup.qq.com";
const QQ_MESSAGE_LIMIT = 1900;
const QQ_MAX_REPLY_PARTS = 5;

type JsonRecord = Record<string, unknown>;

export interface QqRuntimeConfig {
  enabled: boolean;
  botId: string;
  token: string;
  apiBase: string;
  allowedIds: string[];
  mentionOnly: boolean;
  triggerPrefixes: string[];
}

export interface QqWebhookEvent {
  text: string;
  messageId: string;
  channelId: string;
  guildId: string;
  groupId: string;
  userId: string;
  raw: JsonRecord;
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringOrEmpty(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
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

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringOrEmpty(value);
    if (text) return text;
  }
  return "";
}

function nestedRecord(root: JsonRecord, key: string): JsonRecord {
  return recordOrEmpty(root[key]);
}

function normalizeApiBase(value: string): string {
  const raw = value.trim() || QQ_API_BASE;
  return raw.replace(/\/+$/g, "");
}

export function resolveQqRuntimeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): QqRuntimeConfig {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = recordOrEmpty(channels.qq);
  const settings = recordOrEmpty(raw.settings);
  const groupTrigger = recordOrEmpty(
    settings.group_trigger ?? raw.group_trigger,
  );
  const botId = firstString(env.QQ_BOT_ID, settings.bot_id, raw.bot_id);
  const token = firstString(env.QQ_BOT_TOKEN, settings.token, raw.token);

  return {
    enabled:
      raw.enabled === true &&
      botId.length > 0 &&
      token.length > 0 &&
      env.ENABLE_QQ !== "false",
    botId,
    token,
    apiBase: normalizeApiBase(firstString(env.QQ_API_BASE, settings.api_base)),
    allowedIds: stringArray(settings.allow_from ?? raw.allow_from),
    mentionOnly: groupTrigger.mention_only === true,
    triggerPrefixes: stringArray(groupTrigger.prefixes),
  };
}

function qqTextFromRaw(raw: JsonRecord): string {
  const data = nestedRecord(raw, "d");
  const message = nestedRecord(raw, "message");
  return firstString(
    raw.content,
    raw.text,
    raw.message,
    data.content,
    data.text,
    message.content,
    message.text,
  );
}

export function parseQqWebhookEvent(payload: unknown): QqWebhookEvent | null {
  const body = recordOrEmpty(payload);
  const raw =
    Object.keys(recordOrEmpty(body.d)).length > 0
      ? recordOrEmpty(body.d)
      : body;
  const author = nestedRecord(raw, "author");
  const member = nestedRecord(raw, "member");
  const user = nestedRecord(raw, "user");
  const text = qqTextFromRaw(raw);
  const userId = firstString(
    author.id,
    member.user_id,
    user.id,
    raw.user_id,
    raw.author_id,
    raw.sender_id,
  );
  const channelId = firstString(raw.channel_id, raw.channelId);
  const groupId = firstString(raw.group_id, raw.groupId);
  const guildId = firstString(raw.guild_id, raw.guildId);
  if (!text || (!channelId && !groupId && !userId)) return null;
  return {
    text,
    messageId: firstString(raw.id, raw.message_id, raw.msg_id),
    channelId,
    guildId,
    groupId,
    userId,
    raw,
  };
}

export function normalizeQqPrompt(
  text: string,
  botId: string,
  prefixes: string[] = [],
): string {
  let prompt = text
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .replace(new RegExp(`\\[CQ:at,qq=${botId}\\]`, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
  for (const prefix of prefixes) {
    if (prefix && prompt.startsWith(prefix)) {
      prompt = prompt.slice(prefix.length).trim();
      break;
    }
  }
  return prompt;
}

export function shouldHandleQqEvent(
  event: QqWebhookEvent,
  config: QqRuntimeConfig,
): boolean {
  if (!event.text || event.userId === config.botId) return false;
  if (config.allowedIds.length > 0) {
    const allowed = new Set(config.allowedIds);
    const matched =
      allowed.has(event.userId) ||
      allowed.has(event.channelId) ||
      allowed.has(event.groupId) ||
      allowed.has(event.guildId) ||
      allowed.has(`user:${event.userId}`) ||
      allowed.has(`channel:${event.channelId}`) ||
      allowed.has(`group:${event.groupId}`) ||
      allowed.has(`guild:${event.guildId}`);
    if (!matched) return false;
  }
  if (config.mentionOnly && (event.channelId || event.groupId)) {
    const prompt = event.text.trim();
    const mentioned =
      prompt.includes(`<@${config.botId}>`) ||
      prompt.includes(`<@!${config.botId}>`) ||
      prompt.includes(`[CQ:at,qq=${config.botId}]`);
    const prefixMatched = config.triggerPrefixes.some((prefix) =>
      prompt.startsWith(prefix),
    );
    if (!mentioned && !prefixMatched) return false;
  }
  return (
    normalizeQqPrompt(event.text, config.botId, config.triggerPrefixes).length >
    0
  );
}

export function qqSessionId(event: QqWebhookEvent): string {
  const sanitize = (value: string) =>
    value.replace(/[^\w@.+:-]+/g, "_").slice(0, 96) || "unknown";
  return [
    "qq",
    sanitize(event.guildId || event.groupId || event.channelId || "direct"),
    sanitize(event.channelId || event.groupId || event.userId || "unknown"),
    sanitize(event.userId || "unknown"),
  ].join("_");
}

async function postOutboundToQq(
  config: QqRuntimeConfig,
  event: QqWebhookEvent,
  text: string,
): Promise<void> {
  const parts = splitOutboundMessage(text, QQ_MESSAGE_LIMIT).slice(
    0,
    QQ_MAX_REPLY_PARTS,
  );
  if (parts.length === 0) return;
  let endpoint = "";
  if (event.groupId) {
    endpoint = `/v2/groups/${encodeURIComponent(event.groupId)}/messages`;
  } else if (event.channelId) {
    endpoint = `/channels/${encodeURIComponent(event.channelId)}/messages`;
  } else {
    return;
  }
  for (const part of parts) {
    const res = await fetch(`${config.apiBase}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `QQBot ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: part,
        msg_id: event.messageId || undefined,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`QQ reply failed: ${res.status} ${body.slice(0, 200)}`);
    }
  }
}

function requestAuthorized(req: Request, token: string): boolean {
  if (!token) return true;
  const header = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  if (typeof header !== "string" || header.trim() === "") return true;
  return header === `QQBot ${token}` || header === `Bearer ${token}`;
}

export function createQqWebhookRouter(orchestrator: AgentOrchestrator): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    const config = resolveQqRuntimeConfig(orchestrator.config);
    res.json({
      status: config.enabled ? "ready" : "needs_config",
      enabled: config.enabled,
      bot_id_configured: config.botId.length > 0,
    });
  });

  router.post("/", async (req: Request, res: Response) => {
    const config = resolveQqRuntimeConfig(orchestrator.config);
    if (!config.botId || !config.token) {
      return res
        .status(503)
        .json({ error: "QQ bot_id/token are not configured." });
    }
    if (process.env.ENABLE_QQ === "false") {
      return res.status(503).json({ error: "QQ channel is disabled." });
    }
    if (!requestAuthorized(req, config.token)) {
      return res.status(401).json({ error: "Invalid QQ authorization." });
    }

    const event = parseQqWebhookEvent(req.body);
    if (!event || !shouldHandleQqEvent(event, config)) {
      return res.json({ status: "ignored", events: event ? 1 : 0, handled: 0 });
    }

    const prompt = normalizeQqPrompt(
      event.text,
      config.botId,
      config.triggerPrefixes,
    );
    const reply = await collectAgentResponse(
      orchestrator,
      qqSessionId(event),
      prompt,
    );
    void postOutboundToQq(config, event, reply).catch((err) => {
      console.warn(
        `QQ outbound failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    return res.json({
      status: "ok",
      events: 1,
      handled: 1,
      reply: { text: reply, message_id: event.messageId || undefined },
      text: reply,
    });
  });

  return router;
}
