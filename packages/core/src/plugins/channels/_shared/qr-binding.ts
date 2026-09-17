import * as crypto from "crypto";
import { redactSecrets } from "@miki/config";
import QRCode from "qrcode";
import { ProxyAgent } from "undici";

export type QrBindingChannel = "weixin" | "wecom";
export type QrBindingStatus =
  "wait" | "scaned" | "confirmed" | "expired" | "error";

export interface QrBindingFlow {
  id: string;
  channel: QrBindingChannel;
  status: QrBindingStatus;
  qrDataURI?: string;
  qrcode?: string;
  scode?: string;
  accountId?: string;
  botId?: string;
  error?: string;
  pollBaseURL?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface QrBindingFlowResponse {
  flow_id: string;
  status: QrBindingStatus;
  qr_data_uri?: string;
  account_id?: string;
  bot_id?: string;
  error?: string;
}

export const QR_BINDING_FLOW_TTL_MS = 5 * 60 * 1000;
export const QR_BINDING_FLOW_GC_MS = 30 * 60 * 1000;

export function qrBindingFlowID(channel: QrBindingChannel): string {
  return `${channel === "weixin" ? "wx" : "wc"}_${crypto.randomBytes(12).toString("hex")}`;
}

export function isTerminalQrStatus(status: QrBindingStatus): boolean {
  return status === "confirmed" || status === "expired" || status === "error";
}

export function normalizeQrBindingStatus(value: unknown): QrBindingStatus {
  switch (
    String(value || "")
      .trim()
      .toLowerCase()
  ) {
    case "scaned":
    case "scanned":
    case "scaned_but_redirect":
      return "scaned";
    case "confirmed":
    case "success":
      return "confirmed";
    case "expired":
      return "expired";
    case "error":
      return "error";
    default:
      return "wait";
  }
}

export function qrBindingFlowResponse(
  flow: QrBindingFlow,
): QrBindingFlowResponse {
  const response: QrBindingFlowResponse = {
    flow_id: flow.id,
    status: flow.status,
  };
  if (flow.status === "wait" || flow.status === "scaned")
    response.qr_data_uri = flow.qrDataURI;
  if (flow.accountId) response.account_id = flow.accountId;
  if (flow.botId) response.bot_id = flow.botId;
  if (flow.error) response.error = flow.error;
  return response;
}

export async function generateQrDataURI(content: string): Promise<string> {
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: "L",
    margin: 2,
    width: 240,
  });
}

const qrProxyAgents = new Map<string, ProxyAgent>();

export function getQrProxyAgent(proxyURL?: string): ProxyAgent | undefined {
  const normalized = proxyURL?.trim();
  if (!normalized) return undefined;
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("QR binding proxy must use an http:// or https:// URL.");
  }
  let agent = qrProxyAgents.get(normalized);
  if (!agent) {
    agent = new ProxyAgent(normalized);
    qrProxyAgents.set(normalized, agent);
  }
  return agent;
}

export async function fetchQrJson<T>(
  targetURL: string,
  timeoutMs: number,
  options: { proxy?: string } = {},
): Promise<T> {
  const dispatcher = getQrProxyAgent(options.proxy);
  const response = await fetch(targetURL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
  } as RequestInit);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `Provider returned non-JSON response: ${redactSecrets(text.slice(0, 256))}`,
    );
  }
  if (!response.ok)
    throw new Error(
      `Provider HTTP ${response.status}: ${redactSecrets(text.slice(0, 512))}`,
    );
  return body as T;
}

export function urlWithQuery(
  rawURL: string,
  query: Record<string, string | number>,
): string {
  const parsed = new URL(rawURL);
  for (const [key, value] of Object.entries(query))
    parsed.searchParams.set(key, String(value));
  return parsed.toString();
}

export function channelProxyFromConfig(
  config: Record<string, unknown>,
  channel: QrBindingChannel,
): string {
  const channels = config.channels;
  const channelBlock =
    channels && typeof channels === "object" && !Array.isArray(channels)
      ? (channels as Record<string, unknown>)[channel]
      : undefined;
  const raw =
    channelBlock &&
    typeof channelBlock === "object" &&
    !Array.isArray(channelBlock)
      ? (channelBlock as Record<string, unknown>)
      : {};
  const settings =
    raw.settings &&
    typeof raw.settings === "object" &&
    !Array.isArray(raw.settings)
      ? (raw.settings as Record<string, unknown>)
      : {};
  const proxy = settings.proxy ?? raw.proxy;
  return typeof proxy === "string" ? proxy.trim() : "";
}
