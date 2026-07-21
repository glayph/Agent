import { Router, type Request, type Response } from "express";
import * as crypto from "crypto";
import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "./agent-response.js";

const WHATSAPP_MESSAGE_LIMIT = 3500;
const WHATSAPP_MAX_REPLY_PARTS = 5;

type JsonRecord = Record<string, unknown>;

export interface WhatsAppBridgeRuntimeConfig {
  enabled: boolean;
  bridgeUrl: string;
  webhookToken: string;
  allowedIds: string[];
}

export interface WhatsAppBridgeEvent {
  text: string;
  chatId: string;
  senderId: string;
  messageId: string;
  fromMe: boolean;
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

function boolValue(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
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

function eventText(raw: JsonRecord): string {
  const message = nestedRecord(raw, "message");
  const data = nestedRecord(raw, "data");
  const keyMessage = nestedRecord(message, "message");
  const extendedText = nestedRecord(keyMessage, "extendedTextMessage");
  const conversation = stringOrEmpty(keyMessage.conversation);
  return firstString(
    raw.text,
    raw.body,
    raw.content,
    raw.message,
    message.text,
    message.body,
    message.content,
    data.text,
    data.body,
    data.message,
    extendedText.text,
    conversation,
  );
}

function eventChatId(raw: JsonRecord): string {
  const source = nestedRecord(raw, "source");
  const contact = nestedRecord(raw, "contact");
  const message = nestedRecord(raw, "message");
  const key = nestedRecord(message, "key");
  const data = nestedRecord(raw, "data");
  return firstString(
    raw.chat_id,
    raw.chatId,
    raw.remoteJid,
    raw.jid,
    raw.from,
    raw.sender,
    raw.phone,
    source.chat_id,
    source.chatId,
    source.id,
    source.user,
    contact.wa_id,
    message.chat_id,
    message.chatId,
    message.from,
    key.remoteJid,
    data.chat_id,
    data.chatId,
    data.from,
    data.remoteJid,
  );
}

function eventSenderId(raw: JsonRecord, fallback: string): string {
  const source = nestedRecord(raw, "source");
  const message = nestedRecord(raw, "message");
  const key = nestedRecord(message, "key");
  const data = nestedRecord(raw, "data");
  return firstString(
    raw.sender_id,
    raw.senderId,
    raw.sender,
    raw.from,
    source.sender_id,
    source.senderId,
    source.user,
    source.id,
    message.sender_id,
    message.senderId,
    key.participant,
    data.sender_id,
    data.senderId,
    data.sender,
    fallback,
  );
}

function eventMessageId(raw: JsonRecord): string {
  const message = nestedRecord(raw, "message");
  const key = nestedRecord(message, "key");
  const data = nestedRecord(raw, "data");
  return firstString(
    raw.message_id,
    raw.messageId,
    raw.id,
    message.message_id,
    message.messageId,
    message.id,
    key.id,
    data.message_id,
    data.messageId,
    data.id,
  );
}

function eventFromMe(raw: JsonRecord): boolean {
  const message = nestedRecord(raw, "message");
  const key = nestedRecord(message, "key");
  const data = nestedRecord(raw, "data");
  return boolValue(
    raw.from_me ?? raw.fromMe ?? message.fromMe ?? key.fromMe ?? data.fromMe,
  );
}

function sanitizeSessionPart(value: string): string {
  const normalized = value.replace(/[^\w@.+:-]+/g, "_").slice(0, 96);
  return normalized || "unknown";
}

function allowedIdMatches(
  allowedIds: string[],
  event: WhatsAppBridgeEvent,
): boolean {
  if (allowedIds.length === 0) return true;
  const allowed = new Set(allowedIds);
  return (
    allowed.has(event.chatId) ||
    allowed.has(event.senderId) ||
    allowed.has(`chat:${event.chatId}`) ||
    allowed.has(`sender:${event.senderId}`)
  );
}

function timingSafeTokenEquals(expected: string, actual: string): boolean {
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return (
    expectedBytes.length === actualBytes.length &&
    crypto.timingSafeEqual(expectedBytes, actualBytes)
  );
}

function bearerToken(header: unknown): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function requestToken(req: Request): string {
  const body = recordOrEmpty(req.body);
  const queryToken = stringOrEmpty(req.query.token);
  return firstString(
    bearerToken(req.headers.authorization),
    req.headers["x-Hiro-whatsapp-token"],
    req.headers["x-whatsapp-bridge-token"],
    body.token,
    body.webhook_token,
    queryToken,
  );
}

function verifyWebhookToken(req: Request, expectedToken: string): boolean {
  if (!expectedToken) return true;
  return timingSafeTokenEquals(expectedToken, requestToken(req));
}

function normalizeBridgeUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString().replace(/\/+$/g, "");
    }
  } catch {
    return raw.replace(/\/+$/g, "");
  }
  return raw.replace(/\/+$/g, "");
}

export function resolveWhatsAppBridgeRuntimeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppBridgeRuntimeConfig {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = recordOrEmpty(channels.whatsapp);
  const settings = recordOrEmpty(raw.settings);
  const useNative = boolValue(settings.use_native ?? raw.use_native);
  const bridgeUrl = normalizeBridgeUrl(
    stringOrEmpty(
      env.WHATSAPP_BRIDGE_URL ?? settings.bridge_url ?? raw.bridge_url,
    ),
  );
  const webhookToken = stringOrEmpty(
    env.WHATSAPP_WEBHOOK_TOKEN ??
      settings.webhook_token ??
      raw.webhook_token ??
      settings.token ??
      raw.token,
  );

  return {
    enabled:
      raw.enabled === true &&
      !useNative &&
      bridgeUrl.length > 0 &&
      env.ENABLE_WHATSAPP !== "false",
    bridgeUrl,
    webhookToken,
    allowedIds: stringArray(settings.allow_from ?? raw.allow_from),
  };
}

export function parseWhatsAppBridgeEvent(
  payload: unknown,
): WhatsAppBridgeEvent | null {
  const raw = recordOrEmpty(payload);
  if (Object.keys(raw).length === 0) return null;
  const chatId = eventChatId(raw);
  const text = eventText(raw);
  if (!chatId || !text) return null;
  return {
    text,
    chatId,
    senderId: eventSenderId(raw, chatId),
    messageId: eventMessageId(raw),
    fromMe: eventFromMe(raw),
    raw,
  };
}

export function parseWhatsAppBridgeEvents(
  payload: unknown,
): WhatsAppBridgeEvent[] {
  if (Array.isArray(payload)) {
    return payload
      .map(parseWhatsAppBridgeEvent)
      .filter((event): event is WhatsAppBridgeEvent => Boolean(event));
  }
  const body = recordOrEmpty(payload);
  const data = recordOrEmpty(body.data);
  const candidates = [
    body.events,
    body.messages,
    data.events,
    data.messages,
    body.results,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map(parseWhatsAppBridgeEvent)
        .filter((event): event is WhatsAppBridgeEvent => Boolean(event));
    }
  }
  const single = parseWhatsAppBridgeEvent(body);
  return single ? [single] : [];
}

export function shouldHandleWhatsAppBridgeEvent(
  event: WhatsAppBridgeEvent,
  config: WhatsAppBridgeRuntimeConfig,
): boolean {
  if (event.fromMe) return false;
  if (!event.text || !event.chatId) return false;
  return allowedIdMatches(config.allowedIds, event);
}

export function whatsappSessionId(event: WhatsAppBridgeEvent): string {
  return [
    "whatsapp",
    sanitizeSessionPart(event.chatId),
    sanitizeSessionPart(event.senderId || event.chatId),
  ].join("_");
}

async function postOutboundToWhatsAppBridge(
  config: WhatsAppBridgeRuntimeConfig,
  event: WhatsAppBridgeEvent,
  text: string,
): Promise<void> {
  const parts = splitOutboundMessage(text, WHATSAPP_MESSAGE_LIMIT).slice(
    0,
    WHATSAPP_MAX_REPLY_PARTS,
  );
  if (parts.length === 0) return;
  for (const part of parts) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.webhookToken) {
      headers.Authorization = `Bearer ${config.webhookToken}`;
    }
    const res = await fetch(config.bridgeUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        to: event.chatId,
        text: part,
        message_id: event.messageId || undefined,
        channel: "whatsapp",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `WhatsApp bridge send failed: ${res.status} ${body.slice(0, 200)}`,
      );
    }
  }
}

export function createWhatsAppBridgeRouter(
  orchestrator: AgentOrchestrator,
): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    const config = resolveWhatsAppBridgeRuntimeConfig(orchestrator.config);
    res.json({
      status: config.enabled ? "ready" : "needs_config",
      enabled: config.enabled,
      bridge_url_configured: config.bridgeUrl.length > 0,
    });
  });

  const handleWebhook = async (req: Request, res: Response) => {
    const config = resolveWhatsAppBridgeRuntimeConfig(orchestrator.config);
    if (!config.bridgeUrl) {
      return res
        .status(503)
        .json({ error: "WhatsApp bridge URL is not configured." });
    }
    if (process.env.ENABLE_WHATSAPP === "false") {
      return res.status(503).json({ error: "WhatsApp channel is disabled." });
    }
    if (!verifyWebhookToken(req, config.webhookToken)) {
      return res.status(401).json({ error: "Invalid WhatsApp bridge token." });
    }

    const events = parseWhatsAppBridgeEvents(req.body);
    const handledEvents = events.filter((event) =>
      shouldHandleWhatsAppBridgeEvent(event, config),
    );
    if (handledEvents.length === 0) {
      return res.json({
        status: "ignored",
        events: events.length,
        handled: 0,
      });
    }

    const replies = [];
    for (const event of handledEvents) {
      const reply = await collectAgentResponse(
        orchestrator,
        whatsappSessionId(event),
        event.text,
      );
      replies.push({
        to: event.chatId,
        message_id: event.messageId || undefined,
        text: reply,
      });
      void postOutboundToWhatsAppBridge(config, event, reply).catch((err) => {
        console.warn(
          `WhatsApp bridge outbound failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    return res.json({
      status: "ok",
      events: events.length,
      handled: replies.length,
      reply: replies[0] || null,
      replies,
      text: replies[0]?.text || "",
    });
  };

  router.post("/", handleWebhook);
  router.post("/:bridge", handleWebhook);

  return router;
}
