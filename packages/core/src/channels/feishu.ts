import { Router, type Request, type Response } from "express";
import * as crypto from "crypto";
import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "./agent-response.js";

const FEISHU_MESSAGE_LIMIT = 4500;
const FEISHU_MAX_REPLY_PARTS = 5;

type JsonRecord = Record<string, unknown>;

export interface FeishuRuntimeConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  baseUrl: string;
  allowedIds: string[];
  mentionOnly: boolean;
  triggerPrefixes: string[];
}

export interface FeishuWebhookEvent {
  text: string;
  messageId: string;
  chatId: string;
  senderId: string;
  eventType: string;
  mentions: string[];
  raw: JsonRecord;
}

interface FeishuTenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
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

function boolValue(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function feishuBaseUrl(isLark: boolean): string {
  return isLark ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

export function resolveFeishuRuntimeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): FeishuRuntimeConfig {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = recordOrEmpty(channels.feishu);
  const settings = recordOrEmpty(raw.settings);
  const groupTrigger = recordOrEmpty(
    settings.group_trigger ?? raw.group_trigger,
  );
  const appId = firstString(env.FEISHU_APP_ID, settings.app_id, raw.app_id);
  const appSecret = firstString(
    env.FEISHU_APP_SECRET,
    settings.app_secret,
    raw.app_secret,
  );
  const isLark = boolValue(
    env.FEISHU_USE_LARK ?? settings.is_lark ?? raw.is_lark,
  );

  return {
    enabled:
      raw.enabled === true &&
      appId.length > 0 &&
      appSecret.length > 0 &&
      env.ENABLE_FEISHU !== "false",
    appId,
    appSecret,
    verificationToken: firstString(
      env.FEISHU_VERIFICATION_TOKEN,
      settings.verification_token,
      raw.verification_token,
    ),
    encryptKey: firstString(
      env.FEISHU_ENCRYPT_KEY,
      settings.encrypt_key,
      raw.encrypt_key,
    ),
    baseUrl: firstString(env.FEISHU_BASE_URL) || feishuBaseUrl(isLark),
    allowedIds: stringArray(settings.allow_from ?? raw.allow_from),
    mentionOnly: groupTrigger.mention_only === true,
    triggerPrefixes: stringArray(groupTrigger.prefixes),
  };
}

export function decryptFeishuPayload(
  encrypt: string,
  encryptKey: string,
): JsonRecord | null {
  if (!encrypt || !encryptKey) return null;
  try {
    const encrypted = Buffer.from(encrypt, "base64");
    if (encrypted.length <= 16) return null;
    const key = crypto.createHash("sha256").update(encryptKey).digest();
    const iv = encrypted.subarray(0, 16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const decrypted = Buffer.concat([
      decipher.update(encrypted.subarray(16)),
      decipher.final(),
    ]);
    const direct = decrypted.toString("utf-8").trim();
    if (direct.startsWith("{")) return JSON.parse(direct) as JsonRecord;
    if (decrypted.length >= 20) {
      const jsonLength = decrypted.readUInt32BE(16);
      const json = decrypted.subarray(20, 20 + jsonLength).toString("utf-8");
      if (json.trim().startsWith("{")) return JSON.parse(json) as JsonRecord;
    }
  } catch {
    return null;
  }
  return null;
}

export function normalizeFeishuWebhookBody(
  payload: unknown,
  config: FeishuRuntimeConfig,
): JsonRecord {
  const body = recordOrEmpty(payload);
  const encrypted = stringOrEmpty(body.encrypt);
  if (encrypted && config.encryptKey) {
    return decryptFeishuPayload(encrypted, config.encryptKey) || body;
  }
  return body;
}

export function verifyFeishuToken(
  body: JsonRecord,
  verificationToken: string,
): boolean {
  if (!verificationToken) return true;
  const header = nestedRecord(body, "header");
  return (
    firstString(body.token, body.verification_token, header.token) ===
    verificationToken
  );
}

export function feishuChallengeResponse(body: JsonRecord): JsonRecord | null {
  const challenge = firstString(body.challenge);
  const type = firstString(body.type);
  if (!challenge || type !== "url_verification") return null;
  return { challenge };
}

function parseContentText(content: unknown): string {
  if (typeof content !== "string") return "";
  const raw = content.trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as JsonRecord;
    return firstString(parsed.text, parsed.content, parsed.message);
  } catch {
    return raw;
  }
}

function collectMentionIds(mentions: unknown): string[] {
  if (!Array.isArray(mentions)) return [];
  return mentions
    .map((mention) => {
      const item = recordOrEmpty(mention);
      const id = recordOrEmpty(item.id);
      return firstString(
        id.open_id,
        id.user_id,
        id.union_id,
        item.open_id,
        item.user_id,
        item.name,
      );
    })
    .filter(Boolean);
}

export function parseFeishuWebhookEvent(
  payload: unknown,
): FeishuWebhookEvent | null {
  const body = recordOrEmpty(payload);
  const event = recordOrEmpty(body.event);
  const header = recordOrEmpty(body.header);
  const message = nestedRecord(event, "message");
  const sender = nestedRecord(event, "sender");
  const senderId = nestedRecord(sender, "sender_id");
  const oldEvent = Object.keys(event).length > 0 ? event : body;
  const oldMessage = nestedRecord(oldEvent, "message");
  const text = firstString(
    parseContentText(message.content),
    event.text_without_at_bot,
    event.text,
    parseContentText(oldMessage.content),
    oldMessage.text,
    body.text,
  );
  const messageId = firstString(
    message.message_id,
    oldMessage.message_id,
    oldEvent.message_id,
    body.message_id,
  );
  const chatId = firstString(
    message.chat_id,
    oldMessage.chat_id,
    oldEvent.chat_id,
    body.chat_id,
  );
  const userId = firstString(
    senderId.open_id,
    senderId.user_id,
    senderId.union_id,
    oldEvent.open_id,
    oldEvent.user_id,
    body.open_id,
    body.user_id,
  );
  if (!text || (!messageId && !chatId && !userId)) return null;
  return {
    text,
    messageId,
    chatId,
    senderId: userId || chatId || messageId,
    eventType: firstString(header.event_type, body.type, oldEvent.type),
    mentions: collectMentionIds(message.mentions ?? oldMessage.mentions),
    raw: body,
  };
}

export function normalizeFeishuPrompt(
  text: string,
  prefixes: string[] = [],
): string {
  let prompt = text
    .replace(/<at\b[^>]*>.*?<\/at>/gi, "")
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

export function shouldHandleFeishuEvent(
  event: FeishuWebhookEvent,
  config: FeishuRuntimeConfig,
): boolean {
  const prompt = normalizeFeishuPrompt(event.text, config.triggerPrefixes);
  if (!prompt) return false;
  if (config.allowedIds.length > 0) {
    const allowed = new Set(config.allowedIds);
    const matched =
      allowed.has(event.senderId) ||
      allowed.has(event.chatId) ||
      allowed.has(`sender:${event.senderId}`) ||
      allowed.has(`chat:${event.chatId}`);
    if (!matched) return false;
  }
  if (config.mentionOnly && event.chatId && event.mentions.length === 0) {
    const prefixMatched = config.triggerPrefixes.some((prefix) =>
      event.text.trim().startsWith(prefix),
    );
    if (!prefixMatched) return false;
  }
  return true;
}

export function feishuSessionId(event: FeishuWebhookEvent): string {
  const sanitize = (value: string) =>
    value.replace(/[^\w@.+:-]+/g, "_").slice(0, 96) || "unknown";
  return [
    "feishu",
    sanitize(event.chatId || "direct"),
    sanitize(event.senderId || event.messageId || "unknown"),
  ].join("_");
}

async function getTenantAccessToken(
  config: FeishuRuntimeConfig,
): Promise<string> {
  const response = await fetch(
    `${config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = (await response.json().catch(() => ({}))) as
    FeishuTenantTokenResponse | JsonRecord;
  const token = stringOrEmpty(
    "tenant_access_token" in body ? body.tenant_access_token : undefined,
  );
  if (!response.ok || !token) {
    throw new Error(
      `Feishu tenant token failed: ${response.status} ${String(
        "msg" in body ? body.msg || "" : "",
      ).slice(0, 200)}`,
    );
  }
  return token;
}

async function replyToFeishu(
  config: FeishuRuntimeConfig,
  messageId: string,
  text: string,
): Promise<void> {
  if (!messageId) return;
  const token = await getTenantAccessToken(config);
  const parts = splitOutboundMessage(text, FEISHU_MESSAGE_LIMIT).slice(
    0,
    FEISHU_MAX_REPLY_PARTS,
  );
  for (const part of parts) {
    const response = await fetch(
      `${config.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(
        messageId,
      )}/reply`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          msg_type: "text",
          content: JSON.stringify({ text: part }),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(
        `Feishu reply failed: ${response.status} ${body.slice(0, 200)}`,
      );
    }
  }
}

export function createFeishuWebhookRouter(
  orchestrator: AgentOrchestrator,
): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    const config = resolveFeishuRuntimeConfig(orchestrator.config);
    res.json({
      status: config.enabled ? "ready" : "needs_config",
      enabled: config.enabled,
      app_id_configured: config.appId.length > 0,
    });
  });

  router.post("/", async (req: Request, res: Response) => {
    const config = resolveFeishuRuntimeConfig(orchestrator.config);
    if (!config.appId || !config.appSecret) {
      return res
        .status(503)
        .json({ error: "Feishu app_id/app_secret are not configured." });
    }
    if (process.env.ENABLE_FEISHU === "false") {
      return res.status(503).json({ error: "Feishu channel is disabled." });
    }
    const body = normalizeFeishuWebhookBody(req.body, config);
    if (!verifyFeishuToken(body, config.verificationToken)) {
      return res
        .status(401)
        .json({ error: "Invalid Feishu verification token." });
    }
    const challenge = feishuChallengeResponse(body);
    if (challenge) return res.json(challenge);

    const event = parseFeishuWebhookEvent(body);
    if (!event || !shouldHandleFeishuEvent(event, config)) {
      return res.json({ status: "ignored", events: event ? 1 : 0, handled: 0 });
    }

    const prompt = normalizeFeishuPrompt(event.text, config.triggerPrefixes);
    const reply = await collectAgentResponse(
      orchestrator,
      feishuSessionId(event),
      prompt,
    );
    void replyToFeishu(config, event.messageId, reply).catch((err) => {
      console.warn(
        `Feishu outbound failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
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
