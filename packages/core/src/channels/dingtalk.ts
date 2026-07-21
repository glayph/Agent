import { Router, type Request, type Response } from "express";
import * as crypto from "crypto";
import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "./agent-response.js";

const DINGTALK_MESSAGE_LIMIT = 3500;
const DINGTALK_MAX_REPLY_PARTS = 5;

type JsonRecord = Record<string, unknown>;

export interface DingTalkRuntimeConfig {
  enabled: boolean;
  webhookUrl: string;
  clientSecret: string;
  allowedIds: string[];
}

export interface DingTalkWebhookEvent {
  text: string;
  conversationId: string;
  senderId: string;
  senderStaffId: string;
  messageId: string;
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

function normalizeWebhookUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch {
    return raw;
  }
  return raw;
}

export function resolveDingTalkRuntimeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): DingTalkRuntimeConfig {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = recordOrEmpty(channels.dingtalk);
  const settings = recordOrEmpty(raw.settings);
  const webhookUrl = normalizeWebhookUrl(
    firstString(
      env.DINGTALK_WEBHOOK_URL,
      settings.webhook_url,
      raw.webhook_url,
    ),
  );
  const clientSecret = firstString(
    env.DINGTALK_CLIENT_SECRET,
    settings.client_secret,
    raw.client_secret,
  );

  return {
    enabled:
      raw.enabled === true &&
      webhookUrl.length > 0 &&
      env.ENABLE_DINGTALK !== "false",
    webhookUrl,
    clientSecret,
    allowedIds: stringArray(settings.allow_from ?? raw.allow_from),
  };
}

export function signDingTalkWebhookUrl(
  webhookUrl: string,
  clientSecret: string,
  timestamp = Date.now(),
): string {
  if (!clientSecret) return webhookUrl;
  const url = new URL(webhookUrl);
  const sign = crypto
    .createHmac("sha256", clientSecret)
    .update(`${timestamp}\n${clientSecret}`)
    .digest("base64");
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  return url.toString();
}

export function verifyDingTalkSignature(
  timestamp: string,
  signature: string,
  clientSecret: string,
): boolean {
  if (!timestamp || !signature || !clientSecret) return false;
  const expected = crypto
    .createHmac("sha256", clientSecret)
    .update(`${timestamp}\n${clientSecret}`)
    .digest("base64");
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(signature);
  return (
    expectedBytes.length === actualBytes.length &&
    crypto.timingSafeEqual(expectedBytes, actualBytes)
  );
}

function requestSignature(req: Request): {
  timestamp: string;
  signature: string;
} {
  const body = recordOrEmpty(req.body);
  const timestamp = firstString(
    req.headers["x-dingtalk-timestamp"],
    req.query.timestamp,
    body.timestamp,
  );
  const signature = firstString(
    req.headers["x-dingtalk-signature"],
    req.query.sign,
    body.sign,
    body.signature,
  );
  return { timestamp, signature };
}

function requestSignatureAllowed(req: Request, clientSecret: string): boolean {
  if (!clientSecret) return true;
  const { timestamp, signature } = requestSignature(req);
  return verifyDingTalkSignature(timestamp, signature, clientSecret);
}

export function parseDingTalkWebhookEvent(
  payload: unknown,
): DingTalkWebhookEvent | null {
  const raw = recordOrEmpty(payload);
  if (Object.keys(raw).length === 0) return null;
  const textBlock = nestedRecord(raw, "text");
  const msg = nestedRecord(raw, "msg");
  const message = nestedRecord(raw, "message");
  const data = nestedRecord(raw, "data");
  const text = firstString(
    textBlock.content,
    raw.content,
    raw.text,
    raw.message,
    msg.text,
    msg.content,
    message.text,
    message.content,
    data.text,
    data.content,
  );
  const conversationId = firstString(
    raw.conversationId,
    raw.conversation_id,
    raw.chatbotUserId,
    data.conversationId,
    message.conversationId,
  );
  const senderId = firstString(
    raw.senderId,
    raw.sender_id,
    raw.sender,
    raw.userId,
    data.senderId,
    message.senderId,
  );
  const senderStaffId = firstString(
    raw.senderStaffId,
    raw.sender_staff_id,
    raw.staffId,
    data.senderStaffId,
    message.senderStaffId,
  );
  if (!text || (!conversationId && !senderId && !senderStaffId)) return null;
  return {
    text,
    conversationId: conversationId || senderId || senderStaffId,
    senderId: senderId || senderStaffId || conversationId,
    senderStaffId,
    messageId: firstString(raw.msgId, raw.messageId, raw.id, data.msgId),
    raw,
  };
}

export function shouldHandleDingTalkEvent(
  event: DingTalkWebhookEvent,
  config: DingTalkRuntimeConfig,
): boolean {
  if (!event.text) return false;
  if (config.allowedIds.length === 0) return true;
  const allowed = new Set(config.allowedIds);
  return (
    allowed.has(event.conversationId) ||
    allowed.has(event.senderId) ||
    (event.senderStaffId ? allowed.has(event.senderStaffId) : false) ||
    allowed.has(`conversation:${event.conversationId}`) ||
    allowed.has(`sender:${event.senderId}`) ||
    (event.senderStaffId ? allowed.has(`staff:${event.senderStaffId}`) : false)
  );
}

export function dingTalkSessionId(event: DingTalkWebhookEvent): string {
  const sanitize = (value: string) =>
    value.replace(/[^\w@.+:-]+/g, "_").slice(0, 96) || "unknown";
  return [
    "dingtalk",
    sanitize(event.conversationId),
    sanitize(event.senderId || event.senderStaffId || event.conversationId),
  ].join("_");
}

async function postOutboundToDingTalk(
  config: DingTalkRuntimeConfig,
  text: string,
): Promise<void> {
  const parts = splitOutboundMessage(text, DINGTALK_MESSAGE_LIMIT).slice(
    0,
    DINGTALK_MAX_REPLY_PARTS,
  );
  for (const part of parts) {
    const res = await fetch(
      signDingTalkWebhookUrl(config.webhookUrl, config.clientSecret),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "text",
          text: { content: part },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(
        `DingTalk webhook send failed: ${res.status} ${body.slice(0, 200)}`,
      );
    }
    if (body) {
      try {
        const parsed = JSON.parse(body) as JsonRecord;
        if (parsed.errcode !== undefined && parsed.errcode !== 0) {
          throw new Error(
            `DingTalk webhook send failed: ${parsed.errcode} ${String(
              parsed.errmsg || "",
            ).slice(0, 200)}`,
          );
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }
}

export function createDingTalkWebhookRouter(
  orchestrator: AgentOrchestrator,
): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    const config = resolveDingTalkRuntimeConfig(orchestrator.config);
    res.json({
      status: config.enabled ? "ready" : "needs_config",
      enabled: config.enabled,
      webhook_url_configured: config.webhookUrl.length > 0,
    });
  });

  router.post("/", async (req: Request, res: Response) => {
    const config = resolveDingTalkRuntimeConfig(orchestrator.config);
    if (!config.webhookUrl) {
      return res
        .status(503)
        .json({ error: "DingTalk webhook URL is not configured." });
    }
    if (process.env.ENABLE_DINGTALK === "false") {
      return res.status(503).json({ error: "DingTalk channel is disabled." });
    }
    if (!requestSignatureAllowed(req, config.clientSecret)) {
      return res.status(401).json({ error: "Invalid DingTalk signature." });
    }

    const event = parseDingTalkWebhookEvent(req.body);
    if (!event || !shouldHandleDingTalkEvent(event, config)) {
      return res.json({ status: "ignored", events: event ? 1 : 0, handled: 0 });
    }

    const reply = await collectAgentResponse(
      orchestrator,
      dingTalkSessionId(event),
      event.text,
    );
    void postOutboundToDingTalk(config, reply).catch((err) => {
      console.warn(
        `DingTalk outbound failed: ${
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
