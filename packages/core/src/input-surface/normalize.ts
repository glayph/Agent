import { randomUUID } from "node:crypto";
import { looksLikeSessionKey, resolveSessionKey } from "./session-key.js";
import {
  isSurfaceId,
  type InboundEvent,
  type InboundEventInput,
  type SurfaceId,
} from "./types.js";

export { isSurfaceId };

export function normalizeSurface(value: string): SurfaceId {
  const normalized = value.trim().toLowerCase();
  if (isSurfaceId(normalized)) return normalized;
  throw new Error(`Unsupported surface: ${value}`);
}

function normalizeOptional(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeRequired(
  value: unknown,
  field: string,
  fallback?: string,
): string {
  const normalized = normalizeOptional(value) ?? fallback;
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

/**
 * Normalize a partially-filled input into a full InboundEvent.
 * Never returns until surface + sender identity are known.
 */
export function normalizeInboundEvent(input: InboundEventInput): InboundEvent {
  const surface = normalizeSurface(String(input.surface));
  const senderId = normalizeRequired(
    input.sender_meta?.id ?? input.senderId,
    "sender_meta.id",
  );
  const senderName =
    normalizeOptional(input.sender_meta?.name) ??
    normalizeOptional(input.senderName);

  const conversationId =
    normalizeOptional(input.conversationId) ??
    normalizeOptional(input.threadId);

  const agentRole = normalizeOptional(input.agentRole);
  const explicitKey = normalizeOptional(input.session_key);

  const session_key =
    explicitKey && looksLikeSessionKey(explicitKey)
      ? explicitKey
      : resolveSessionKey({
          surface,
          conversationId:
            conversationId ??
            (explicitKey && !looksLikeSessionKey(explicitKey)
              ? explicitKey
              : undefined) ??
            senderId,
          agentRole,
        });

  const suppliedIdempotencyKey = normalizeOptional(input.idempotencyKey);
  const eventId =
    normalizeOptional(input.eventId) ??
    suppliedIdempotencyKey ??
    randomUUID();
  const timestamp =
    normalizeOptional(input.timestamp) ?? new Date().toISOString();
  const correlationId = normalizeOptional(input.correlationId) ?? eventId;
  const idempotencyKey = suppliedIdempotencyKey ?? `${surface}:${eventId}`;

  const replyChannel = input.replyRoute?.channel
    ? normalizeSurface(String(input.replyRoute.channel))
    : surface;
  const replyAddress = normalizeRequired(
    input.replyRoute?.address ?? senderId,
    "replyRoute.address",
  );

  const payload =
    input.payload &&
    typeof input.payload === "object" &&
    !Array.isArray(input.payload)
      ? { ...input.payload }
      : {};

  return {
    eventId,
    idempotencyKey,
    surface,
    session_key,
    payload,
    timestamp,
    sender_meta: {
      id: senderId,
      ...(senderName ? { name: senderName } : {}),
    },
    channel: surface,
    sessionId: session_key,
    correlationId,
    replyRoute: { channel: replyChannel, address: replyAddress },
  };
}
