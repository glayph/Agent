import * as net from "net";
import * as tls from "tls";
import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "./agent-response.js";

const MQTT_PROTOCOL_LEVEL = 4; // MQTT 3.1.1
const MQTT_MESSAGE_LIMIT = 3500;
const MAX_MQTT_PACKET_SIZE = 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export interface MqttRuntimeConfig {
  enabled: boolean;
  broker: string;
  agentId: string;
  topicPrefix: string;
  clientId: string;
  username: string;
  password: string;
  keepAliveSeconds: number;
  qos: 0 | 1;
  reconnect: boolean;
}

export interface MqttPacket {
  type: number;
  flags: number;
  payload: Buffer;
}

export interface MqttPublishMessage {
  topic: string;
  payload: Buffer;
  qos: 0 | 1 | 2;
  packetId: number | null;
}

export interface MqttRequestInfo {
  clientId: string;
  responseTopic: string;
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrDefault(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeQos(value: unknown): 0 | 1 {
  const qos = numberOrDefault(value, 0);
  return qos >= 1 ? 1 : 0;
}

function normalizeTopicPrefix(value: unknown): string {
  const raw = stringOrEmpty(value) || "/Hiro";
  return raw.replace(/\/+$/g, "") || "/Hiro";
}

function encodeRemainingLength(length: number): Buffer {
  if (
    !Number.isInteger(length) ||
    length < 0 ||
    length > MAX_MQTT_PACKET_SIZE
  ) {
    throw new Error("Invalid MQTT remaining length");
  }
  const bytes: number[] = [];
  let remaining = length;
  do {
    let encoded = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) encoded |= 128;
    bytes.push(encoded);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function encodeUtf8(value: string): Buffer {
  const body = Buffer.from(value, "utf-8");
  if (body.length > 0xffff) throw new Error("MQTT string is too long");
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function readUtf8(
  buffer: Buffer,
  offset: number,
): { value: string; offset: number } {
  if (offset + 2 > buffer.length) throw new Error("Invalid MQTT string");
  const length = buffer.readUInt16BE(offset);
  const start = offset + 2;
  const end = start + length;
  if (end > buffer.length) throw new Error("Truncated MQTT string");
  return { value: buffer.subarray(start, end).toString("utf-8"), offset: end };
}

function mqttPacket(typeAndFlags: number, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([typeAndFlags]),
    encodeRemainingLength(payload.length),
    payload,
  ]);
}

export function buildMqttConnectPacket(config: MqttRuntimeConfig): Buffer {
  let flags = 0b00000010; // clean session
  const payloadParts = [encodeUtf8(config.clientId)];
  if (config.username) {
    flags |= 0b10000000;
    payloadParts.push(encodeUtf8(config.username));
  }
  if (config.password) {
    flags |= 0b01000000;
    payloadParts.push(encodeUtf8(config.password));
  }
  const keepAlive = Math.max(5, Math.min(65_535, config.keepAliveSeconds));
  const variableHeader = Buffer.concat([
    encodeUtf8("MQTT"),
    Buffer.from([MQTT_PROTOCOL_LEVEL, flags]),
    Buffer.from([(keepAlive >> 8) & 0xff, keepAlive & 0xff]),
  ]);
  return mqttPacket(0x10, Buffer.concat([variableHeader, ...payloadParts]));
}

export function buildMqttSubscribePacket(
  filters: string[],
  packetId: number,
  qos: 0 | 1,
): Buffer {
  if (filters.length === 0) throw new Error("MQTT subscribe requires a topic");
  const id = Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]);
  const topics = filters.map((filter) =>
    Buffer.concat([encodeUtf8(filter), Buffer.from([qos])]),
  );
  return mqttPacket(0x82, Buffer.concat([id, ...topics]));
}

export function buildMqttPublishPacket(topic: string, payload: Buffer): Buffer {
  return mqttPacket(0x30, Buffer.concat([encodeUtf8(topic), payload]));
}

export function buildMqttPubackPacket(packetId: number): Buffer {
  return mqttPacket(
    0x40,
    Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]),
  );
}

export function parseMqttPackets(buffer: Buffer): {
  packets: MqttPacket[];
  remaining: Buffer;
} {
  const packets: MqttPacket[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const packetStart = offset;
    const first = buffer[offset++];
    let multiplier = 1;
    let remainingLength = 0;
    let encoded: number;
    let lengthBytes = 0;

    do {
      if (offset >= buffer.length) {
        return { packets, remaining: buffer.subarray(packetStart) };
      }
      encoded = buffer[offset++];
      remainingLength += (encoded & 127) * multiplier;
      multiplier *= 128;
      lengthBytes += 1;
      if (lengthBytes > 4 || remainingLength > MAX_MQTT_PACKET_SIZE) {
        throw new Error("Invalid MQTT packet size");
      }
    } while ((encoded & 128) !== 0);

    const payloadEnd = offset + remainingLength;
    if (payloadEnd > buffer.length) {
      return { packets, remaining: buffer.subarray(packetStart) };
    }

    packets.push({
      type: first >> 4,
      flags: first & 0x0f,
      payload: buffer.subarray(offset, payloadEnd),
    });
    offset = payloadEnd;
  }

  return { packets, remaining: Buffer.alloc(0) };
}

export function parseMqttPublishPacket(packet: MqttPacket): MqttPublishMessage {
  if (packet.type !== 3) throw new Error("MQTT packet is not PUBLISH");
  const qos = ((packet.flags >> 1) & 0x03) as 0 | 1 | 2;
  const topic = readUtf8(packet.payload, 0);
  let offset = topic.offset;
  let packetId: number | null = null;
  if (qos > 0) {
    if (offset + 2 > packet.payload.length) {
      throw new Error("MQTT PUBLISH missing packet id");
    }
    packetId = packet.payload.readUInt16BE(offset);
    offset += 2;
  }
  return {
    topic: topic.value,
    payload: packet.payload.subarray(offset),
    qos,
    packetId,
  };
}

export function resolveMqttRuntimeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): MqttRuntimeConfig {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = recordOrEmpty(channels.mqtt);
  const settings = recordOrEmpty(raw.settings);
  const broker = stringOrEmpty(
    env.MQTT_BROKER ?? settings.broker ?? raw.broker,
  );
  const agentId = stringOrEmpty(
    env.MQTT_AGENT_ID ?? settings.agent_id ?? raw.agent_id,
  );
  const clientId =
    stringOrEmpty(env.MQTT_CLIENT_ID ?? settings.client_id ?? raw.client_id) ||
    `Hiro-${agentId || "agent"}`;

  return {
    enabled:
      raw.enabled === true &&
      broker.length > 0 &&
      agentId.length > 0 &&
      env.ENABLE_MQTT !== "false",
    broker,
    agentId,
    topicPrefix: normalizeTopicPrefix(
      env.MQTT_TOPIC_PREFIX ?? settings.topic_prefix ?? raw.topic_prefix,
    ),
    clientId,
    username: stringOrEmpty(
      env.MQTT_USERNAME ?? settings.username ?? raw.username,
    ),
    password: stringOrEmpty(
      env.MQTT_PASSWORD ?? settings.password ?? raw.password,
    ),
    keepAliveSeconds: Math.max(
      5,
      Math.min(
        65_535,
        Math.floor(
          numberOrDefault(
            env.MQTT_KEEP_ALIVE ?? settings.keep_alive ?? raw.keep_alive,
            60,
          ),
        ),
      ),
    ),
    qos: normalizeQos(env.MQTT_QOS ?? settings.qos ?? raw.qos),
    reconnect: raw.reconnect !== false,
  };
}

export function mqttRequestInfo(
  topic: string,
  config: Pick<MqttRuntimeConfig, "agentId" | "topicPrefix">,
): MqttRequestInfo | null {
  const base = `${config.topicPrefix}/${config.agentId}`;
  if (topic === `${base}/request`) {
    return { clientId: "default", responseTopic: `${base}/response` };
  }
  if (!topic.startsWith(`${base}/`) || !topic.endsWith("/request")) {
    return null;
  }
  const clientId = topic.slice(base.length + 1, -"/request".length);
  if (!clientId || clientId.includes("/")) return null;
  return {
    clientId,
    responseTopic: `${base}/${clientId}/response`,
  };
}

export function parseMqttRequestPayload(payload: Buffer): string {
  const raw = payload.toString("utf-8").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; message?: unknown };
    const text =
      typeof parsed.text === "string"
        ? parsed.text
        : typeof parsed.message === "string"
          ? parsed.message
          : "";
    return text.trim();
  } catch {
    return raw;
  }
}

export class MqttBot {
  private readonly orchestrator: AgentOrchestrator;
  private socket: net.Socket | tls.TLSSocket | null = null;
  private runtimeConfig: MqttRuntimeConfig | null = null;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private packetId = 1;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private started = false;
  private stopping = false;

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
  }

  start(): void {
    if (this.started) return;
    const config = resolveMqttRuntimeConfig(this.orchestrator.config);
    this.runtimeConfig = config;
    if (!config.enabled) {
      if (!config.broker || !config.agentId) {
        console.log(
          "MQTT disabled: MQTT_BROKER or MQTT_AGENT_ID not configured",
        );
      } else if (process.env["ENABLE_MQTT"] === "false") {
        console.log("MQTT disabled via ENABLE_MQTT=false");
      } else {
        console.log("MQTT disabled in channel configuration");
      }
      return;
    }

    this.started = true;
    this.stopping = false;
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    this.clearPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.end(Buffer.from([0xe0, 0x00]));
        this.socket.destroy();
      } catch {
        // Ignore shutdown socket errors.
      }
      this.socket = null;
    }
  }

  private connect(): void {
    const config = this.runtimeConfig;
    if (!config?.enabled || this.stopping) return;

    let url: URL;
    try {
      url = new URL(config.broker);
    } catch {
      console.warn(`MQTT broker URL is invalid: ${config.broker}`);
      return;
    }

    const secure = url.protocol === "mqtts:" || url.protocol === "ssl:";
    const port = Number(url.port || (secure ? 8883 : 1883));
    const host = url.hostname;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
      console.warn(`MQTT broker host/port is invalid: ${config.broker}`);
      return;
    }

    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    socket.setNoDelay(true);
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    let connectPacketSent = false;
    const sendConnectPacket = () => {
      if (connectPacketSent) return;
      connectPacketSent = true;
      this.write(buildMqttConnectPacket(config));
    };

    socket.on("connect", sendConnectPacket);
    socket.on("secureConnect", sendConnectPacket);
    socket.on("data", (chunk) => {
      this.handleData(chunk).catch((err) => {
        console.warn(
          `MQTT packet handling failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });
    socket.on("close", () => {
      this.clearPing();
      this.socket = null;
      if (!this.stopping && this.started && config.reconnect) {
        this.scheduleReconnect();
      }
    });
    socket.on("error", (err) => {
      console.warn(`MQTT socket error: ${err.message}`);
    });
  }

  private async handleData(chunk: Buffer): Promise<void> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const parsed = parseMqttPackets(this.buffer);
    this.buffer = parsed.remaining;
    for (const packet of parsed.packets) {
      await this.handlePacket(packet);
    }
  }

  private async handlePacket(packet: MqttPacket): Promise<void> {
    const config = this.runtimeConfig;
    if (!config) return;

    if (packet.type === 2) {
      const returnCode = packet.payload[1];
      if (returnCode !== 0) {
        throw new Error(
          `MQTT CONNACK rejected connection with code ${returnCode}`,
        );
      }
      this.reconnectAttempts = 0;
      this.subscribe(config);
      this.startPing(config.keepAliveSeconds);
      console.log("MQTT broker connected");
      return;
    }

    if (packet.type === 3) {
      const publish = parseMqttPublishPacket(packet);
      if (publish.qos === 1 && publish.packetId != null) {
        this.write(buildMqttPubackPacket(publish.packetId));
      }
      await this.handlePublish(publish, config);
      return;
    }

    if (packet.type === 13) {
      return;
    }
  }

  private async handlePublish(
    publish: MqttPublishMessage,
    config: MqttRuntimeConfig,
  ): Promise<void> {
    const request = mqttRequestInfo(publish.topic, config);
    if (!request) return;
    const prompt = parseMqttRequestPayload(publish.payload);
    if (!prompt) return;

    const sessionId = ["mqtt", config.agentId, request.clientId].join("_");
    const response = await collectAgentResponse(
      this.orchestrator,
      sessionId,
      prompt,
    );
    for (const part of splitOutboundMessage(response, MQTT_MESSAGE_LIMIT)) {
      const payload = Buffer.from(
        JSON.stringify({
          text: part,
          request_topic: publish.topic,
          checked_at: new Date().toISOString(),
        }),
        "utf-8",
      );
      this.write(buildMqttPublishPacket(request.responseTopic, payload));
    }
  }

  private subscribe(config: MqttRuntimeConfig): void {
    const base = `${config.topicPrefix}/${config.agentId}`;
    const filters = [`${base}/+/request`, `${base}/request`];
    this.write(
      buildMqttSubscribePacket(filters, this.nextPacketId(), config.qos),
    );
  }

  private startPing(keepAliveSeconds: number): void {
    this.clearPing();
    const intervalMs = Math.max(5_000, Math.floor(keepAliveSeconds * 500));
    this.pingTimer = setInterval(() => {
      this.write(Buffer.from([0xc0, 0x00]));
    }, intervalMs);
    this.pingTimer.unref?.();
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping || !this.started) return;
    this.reconnectAttempts += 1;
    const delayMs = Math.min(60_000, 1_000 * 2 ** this.reconnectAttempts);
    console.log(
      `MQTT reconnect attempt ${this.reconnectAttempts} in ${delayMs}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private nextPacketId(): number {
    this.packetId = this.packetId >= 65_535 ? 1 : this.packetId + 1;
    return this.packetId;
  }

  private write(packet: Buffer): void {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return;
    socket.write(packet);
  }
}
