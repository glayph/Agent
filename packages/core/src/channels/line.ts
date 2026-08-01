import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "./agent-response.js";

const LINE_API_BASE = "https://api.line.me/v2/bot";
const LINE_MESSAGE_LIMIT = 4900;
const LINE_MAX_REPLY_MESSAGES = 5;

type JsonRecord = Record<string, unknown>;

export interface LineRuntimeConfig {
  enabled: boolean;
  token: string;
  channelSecret: string;
  allowedIds: string[];
}

export interface LineWebhookEvent {
  type?: string;
  replyToken?: string;
  message?: {
    type?: string;
    text?: string;
  };
  source?: {
    type?: string;
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
}

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
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

export function resolveLineRuntimeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): LineRuntimeConfig {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = recordOrEmpty(channels.line);
  const settings = recordOrEmpty(raw.settings);
  const token = stringOrEmpty(
    env.LINE_CHANNEL_ACCESS_TOKEN ?? settings.token ?? raw.token,
  );
  const channelSecret = stringOrEmpty(
    env.LINE_CHANNEL_SECRET ?? settings.channel_secret ?? raw.channel_secret,
  );

  return {
    enabled:
      raw.enabled === true &&
      token.length > 0 &&
      channelSecret.length > 0 &&
      env.ENABLE_LINE !== "false",
    token,
    channelSecret,
    allowedIds: stringArray(settings.allow_from ?? raw.allow_from),
  };
}

export function verifyLineSignature(
  rawBody: Buffer,
  channelSecret: string,
  signature: string | undefined,
): boolean {
  if (!signature || !channelSecret) return false;
  const expected = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  const expectedBytes = Buffer.from(expected);
  const signatureBytes = Buffer.from(signature);
  return (
    expectedBytes.length === signatureBytes.length &&
    crypto.timingSafeEqual(expectedBytes, signatureBytes)
  );
}

export function shouldHandleLineEvent(
  event: LineWebhookEvent,
  config: LineRuntimeConfig,
): boolean {
  if (event.type !== "message") return false;
  if (event.message?.type !== "text") return false;
  if (!stringOrEmpty(event.message.text) || !event.replyToken) return false;

  if (config.allowedIds.length > 0) {
    const allowed = new Set(config.allowedIds);
    const source = event.source || {};
    const matched =
      (source.userId ? allowed.has(source.userId) : false) ||
      (source.groupId ? allowed.has(source.groupId) : false) ||
      (source.roomId ? allowed.has(source.roomId) : false);
    if (!matched) return false;
  }

  return true;
}

function lineSessionId(event: LineWebhookEvent): string {
  const source = event.source || {};
  return [
    "line",
    source.type || "source",
    source.groupId || source.roomId || source.userId || "unknown",
  ].join("_");
}

async function replyToLine(
  token: string,
  replyToken: string,
  text: string,
): Promise<void> {
  const messages = splitOutboundMessage(text, LINE_MESSAGE_LIMIT)
    .slice(0, LINE_MAX_REPLY_MESSAGES)
    .map((part) => ({ type: "text", text: part }));
  if (messages.length === 0) return;

  const res = await fetch(`${LINE_API_BASE}/message/reply`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LINE reply failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

export function createLineWebhookRouter(
  orchestrator: AgentOrchestrator,
): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    const config = resolveLineRuntimeConfig(orchestrator.config);
    res.json({
      status: config.enabled ? "ready" : "needs_config",
      enabled: config.enabled,
    });
  });

  router.post("/", async (req: RawBodyRequest, res: Response) => {
    const config = resolveLineRuntimeConfig(orchestrator.config);
    if (!config.token || !config.channelSecret) {
      return res.status(503).json({ error: "LINE channel is not configured." });
    }
    if (process.env.ENABLE_LINE === "false") {
      return res.status(503).json({ error: "LINE channel is disabled." });
    }

    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const signature = Array.isArray(req.headers["x-line-signature"])
      ? req.headers["x-line-signature"][0]
      : req.headers["x-line-signature"];
    if (!verifyLineSignature(rawBody, config.channelSecret, signature)) {
      return res.status(401).json({ error: "Invalid LINE signature." });
    }

    const events = Array.isArray(req.body?.events)
      ? (req.body.events as LineWebhookEvent[])
      : [];
    res.json({ status: "accepted", events: events.length });

    for (const event of events) {
      if (!shouldHandleLineEvent(event, config)) continue;
      const prompt = stringOrEmpty(event.message?.text);
      const replyToken = stringOrEmpty(event.replyToken);
      if (!prompt || !replyToken) continue;
      void collectAgentResponse(orchestrator, lineSessionId(event), prompt)
        .then((reply) => replyToLine(config.token, replyToken, reply))
        .catch((err) => {
          console.warn(
            `LINE webhook handling failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }
  });

  return router;
}
