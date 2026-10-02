import { normalizeInboundEvent } from "./normalize.js";
import type {
  InboundEventInput,
  SurfaceAdapter,
  SurfaceId,
} from "./types.js";
import { SURFACES, isSurfaceId } from "./types.js";

const ENVELOPE_KEYS = new Set([
  "eventId",
  "idempotencyKey",
  "surface",
  "channel",
  "session_key",
  "sessionId",
  "conversationId",
  "threadId",
  "agentRole",
  "role",
  "senderId",
  "senderName",
  "sender_meta",
  "timestamp",
  "receivedAt",
  "correlationId",
  "replyRoute",
  "payload",
]);

function asRecord(raw: unknown, surface: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${surface} event must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

function stringField(
  body: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Generic JSON adapter shared by most surfaces.
 * Accepts either already-shaped fields or common aliases (senderId, text, message).
 */
export function createJsonSurfaceAdapter(surface: SurfaceId): SurfaceAdapter {
  return {
    surface,
    normalize(raw, context) {
      const body = asRecord(raw, surface);
      const nestedPayload =
        body.payload &&
        typeof body.payload === "object" &&
        !Array.isArray(body.payload)
          ? (body.payload as Record<string, unknown>)
          : undefined;

      const text =
        stringField(body, "text", "message") ??
        (nestedPayload
          ? stringField(nestedPayload, "text", "message")
          : undefined);

      const payload: Record<string, unknown> = nestedPayload
        ? { ...nestedPayload }
        : { ...body };

      if (text) {
        if (payload.text === undefined) payload.text = text;
        if (payload.message === undefined) payload.message = text;
      }

      if (!nestedPayload) {
        for (const key of ENVELOPE_KEYS) {
          delete payload[key];
        }
      }

      // Explicit session_key only; legacy sessionId → conversationId
      const explicitSessionKey = stringField(body, "session_key");
      const conversationId = stringField(
        body,
        "conversationId",
        "threadId",
        "sessionId",
      );

      const input: InboundEventInput = {
        surface,
        eventId: stringField(body, "eventId"),
        idempotencyKey: stringField(body, "idempotencyKey"),
        session_key: explicitSessionKey,
        conversationId,
        threadId: stringField(body, "threadId"),
        agentRole: stringField(body, "agentRole", "role"),
        senderId: stringField(body, "senderId") ?? context?.senderId,
        senderName: stringField(body, "senderName"),
        sender_meta:
          body.sender_meta && typeof body.sender_meta === "object"
            ? (body.sender_meta as InboundEventInput["sender_meta"])
            : undefined,
        timestamp: stringField(body, "timestamp", "receivedAt"),
        correlationId: stringField(body, "correlationId"),
        replyRoute:
          body.replyRoute && typeof body.replyRoute === "object"
            ? (body.replyRoute as InboundEventInput["replyRoute"])
            : undefined,
        payload,
      };

      return normalizeInboundEvent(input);
    },
  };
}

/** Cached adapters for hot paths (CLI / webhook). */
const cliJsonAdapter = createJsonSurfaceAdapter("cli");
const webhookJsonAdapter = createJsonSurfaceAdapter("webhook");

/** CLI adapter: accepts string prompt or { text/message, session? }. */
export function createCliAdapter(): SurfaceAdapter {
  return {
    surface: "cli",
    normalize(raw, context) {
      if (typeof raw === "string") {
        return normalizeInboundEvent({
          surface: "cli",
          senderId: context?.senderId ?? "cli-user",
          conversationId: "cli-main",
          agentRole: "default",
          payload: { text: raw, message: raw },
        });
      }
      return cliJsonAdapter.normalize(raw, {
        senderId: context?.senderId ?? "cli-user",
      });
    },
  };
}

/** Webhook adapter for HTTP webhooks and acceptance tests. */
export function createWebhookAdapter(): SurfaceAdapter {
  return {
    surface: "webhook",
    normalize(raw, context) {
      return webhookJsonAdapter.normalize(raw, {
        senderId: context?.senderId ?? "webhook",
      });
    },
  };
}

export function createDefaultSurfaceAdapters(): SurfaceAdapter[] {
  const adapters: SurfaceAdapter[] = [
    createCliAdapter(),
    createWebhookAdapter(),
  ];
  for (const surface of SURFACES) {
    if (surface === "cli" || surface === "webhook") continue;
    adapters.push(createJsonSurfaceAdapter(surface));
  }
  return adapters;
}

/** Map legacy channel name → surface id (no adapter allocation). */
export function channelToSurface(channel: string): SurfaceId {
  const n = channel.trim().toLowerCase();
  if (isSurfaceId(n)) return n;
  return "api";
}
