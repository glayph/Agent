import { createHash } from "node:crypto";

export const CHANNELS = [
  "web",
  "webhook",
  "api",
  "timer",
  "telegram",
  "whatsapp",
  "discord",
  "slack",
  "email",
] as const;

export type ChannelName = (typeof CHANNELS)[number];

export interface InboundEvent {
  eventId: string;
  idempotencyKey: string;
  channel: ChannelName;
  sender: { id: string; name?: string };
  sessionId: string;
  correlationId: string;
  receivedAt: string;
  replyRoute: { channel: ChannelName; address: string };
  payload: Record<string, unknown>;
}

export interface InboundEventInput {
  eventId?: string;
  idempotencyKey?: string;
  channel: ChannelName | string;
  sender?: { id?: string; name?: string };
  sessionId?: string;
  correlationId?: string;
  receivedAt?: string;
  replyRoute?: { channel?: ChannelName | string; address?: string };
  payload?: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly channel: ChannelName;
  normalize(input: unknown, context?: { senderId?: string }): InboundEvent;
}

export class ChannelAdapterRegistry {
  private readonly adapters = new Map<ChannelName, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  has(channel: string): channel is ChannelName {
    return this.adapters.has(channel as ChannelName);
  }

  normalize(
    channel: string,
    input: unknown,
    context?: { senderId?: string },
  ): InboundEvent {
    const adapter = this.adapters.get(channel as ChannelName);
    if (!adapter) throw new Error(`Unsupported channel: ${channel}`);
    return adapter.normalize(input, context);
  }

  list(): ChannelName[] {
    return [...this.adapters.keys()];
  }
}

export function createDefaultChannelRegistry(): ChannelAdapterRegistry {
  const registry = new ChannelAdapterRegistry();
  for (const channel of CHANNELS) {
    registry.register(createJsonChannelAdapter(channel));
  }
  return registry;
}

export function normalizeInboundEvent(input: InboundEventInput): InboundEvent {
  const channel = normalizeChannel(input.channel);
  const senderId = normalizeRequired(input.sender?.id, "sender.id");
  const sessionId = normalizeRequired(input.sessionId, "sessionId", senderId);
  const eventId = normalizeOptional(input.eventId) ?? crypto.randomUUID();
  const receivedAt =
    normalizeOptional(input.receivedAt) ?? new Date().toISOString();
  const correlationId = normalizeOptional(input.correlationId) ?? eventId;
  const replyChannel = normalizeChannel(input.replyRoute?.channel ?? channel);
  const address = normalizeRequired(
    input.replyRoute?.address ?? senderId,
    "replyRoute.address",
  );
  const idempotencyKey =
    normalizeOptional(input.idempotencyKey) ?? `${channel}:${eventId}`;
  return {
    eventId,
    idempotencyKey,
    channel,
    sender: {
      id: senderId,
      ...(normalizeOptional(input.sender?.name)
        ? { name: normalizeOptional(input.sender?.name) }
        : {}),
    },
    sessionId,
    correlationId,
    receivedAt,
    replyRoute: { channel: replyChannel, address },
    payload: input.payload ?? {},
  };
}

function createJsonChannelAdapter(channel: ChannelName): ChannelAdapter {
  return {
    channel,
    normalize(input, context) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error(`${channel} event must be a JSON object`);
      }
      const body = input as Record<string, unknown>;
      return normalizeInboundEvent({
        channel,
        eventId: typeof body.eventId === "string" ? body.eventId : undefined,
        idempotencyKey:
          typeof body.idempotencyKey === "string"
            ? body.idempotencyKey
            : undefined,
        sender: {
          id:
            typeof body.senderId === "string"
              ? body.senderId
              : context?.senderId,
          name:
            typeof body.senderName === "string" ? body.senderName : undefined,
        },
        sessionId:
          typeof body.sessionId === "string" ? body.sessionId : undefined,
        correlationId:
          typeof body.correlationId === "string"
            ? body.correlationId
            : undefined,
        receivedAt:
          typeof body.receivedAt === "string" ? body.receivedAt : undefined,
        replyRoute:
          body.replyRoute && typeof body.replyRoute === "object"
            ? (body.replyRoute as { channel?: ChannelName; address?: string })
            : undefined,
        payload:
          body.payload && typeof body.payload === "object"
            ? (body.payload as Record<string, unknown>)
            : body,
      });
    },
  };
}

function normalizeChannel(value: string): ChannelName {
  const normalized = value.trim().toLowerCase();
  if ((CHANNELS as readonly string[]).includes(normalized)) {
    return normalized as ChannelName;
  }
  throw new Error(`Unsupported channel: ${value}`);
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

function normalizeOptional(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function stableEventFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
