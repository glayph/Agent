/**
 * Step 06 — Input-Surface layer types.
 *
 * "Surface" generalizes OpenClaw channels: any place work can enter
 * (CLI, IDE, task API, webhook, chat apps). All surfaces normalize into
 * one InboundEvent shape so origin and processing stay decoupled.
 */

export const SURFACES = [
  "cli",
  "ide",
  "task_api",
  "webhook",
  "web",
  "api",
  "timer",
  "telegram",
  "whatsapp",
  "discord",
  "slack",
  "email",
] as const;

export type SurfaceId = (typeof SURFACES)[number];

export function isSurfaceId(value: string): value is SurfaceId {
  return (SURFACES as readonly string[]).includes(value.trim().toLowerCase());
}

export interface InboundPayload {
  text?: string;
  message?: string;
  attachments?: unknown[];
  [key: string]: unknown;
}

export interface SenderMeta {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Common inbound event after normalization.
 * session_key is the serialization key for Step 07 queue (surface + thread + role).
 */
export interface InboundEvent {
  eventId: string;
  idempotencyKey: string;
  surface: SurfaceId;
  session_key: string;
  payload: InboundPayload;
  timestamp: string;
  sender_meta: SenderMeta;
  /** Backward-compatible aliases used by existing event-envelope consumers. */
  channel?: SurfaceId;
  sessionId?: string;
  correlationId?: string;
  replyRoute?: { channel: SurfaceId; address: string };
}

export interface InboundEventInput {
  eventId?: string;
  idempotencyKey?: string;
  surface: SurfaceId | string;
  session_key?: string;
  conversationId?: string;
  threadId?: string;
  agentRole?: string;
  payload?: InboundPayload;
  timestamp?: string;
  sender_meta?: Partial<SenderMeta> & { id?: string };
  senderId?: string;
  senderName?: string;
  correlationId?: string;
  replyRoute?: { channel?: string; address?: string };
}

export interface SurfaceAdapter {
  readonly surface: SurfaceId;
  normalize(raw: unknown, context?: { senderId?: string }): InboundEvent;
}

export type IngestSink = (event: InboundEvent) => void | Promise<void>;
