import {
  fetchQrJson,
  generateQrDataURI,
  isTerminalQrStatus,
  normalizeQrBindingStatus,
  qrBindingFlowID,
  qrBindingFlowResponse,
  QR_BINDING_FLOW_TTL_MS,
  type QrBindingFlow,
  type QrBindingFlowResponse,
} from "../_shared/qr-binding.js";

const WECOM_QR_SOURCE_ID = "Miki";
const WECOM_QR_GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate";
const WECOM_QR_QUERY_URL = "https://work.weixin.qq.com/ai/qc/query_result";
const WECOM_DEFAULT_WEBSOCKET_URL = "wss://openws.work.weixin.qq.com";

interface WecomQrGenerateResponse {
  errcode?: number;
  errmsg?: string;
  data?: { scode?: string; auth_url?: string };
}

interface WecomQrQueryResponse {
  errcode?: number;
  errmsg?: string;
  data?: { status?: string; bot_info?: { botid?: string; secret?: string } };
}

export type SaveWecomChannel = (
  settings: Record<string, unknown>,
) => Promise<void>;

function wecomPlatformCode(): number {
  switch (process.platform) {
    case "darwin":
      return 1;
    case "win32":
      return 2;
    case "linux":
      return 3;
    default:
      return 0;
  }
}

async function fetchWecomQrCode(): Promise<WecomQrGenerateResponse> {
  const body = await fetchQrJson<WecomQrGenerateResponse>(
    `${WECOM_QR_GENERATE_URL}?source=${encodeURIComponent(WECOM_QR_SOURCE_ID)}&sourceID=${encodeURIComponent(WECOM_QR_SOURCE_ID)}&plat=${wecomPlatformCode()}`,
    15_000,
  );
  if (body.errcode != null && body.errcode !== 0)
    throw new Error(`WeCom QR error ${body.errcode}: ${body.errmsg || ""}`);
  if (!body.data?.scode || !body.data.auth_url)
    throw new Error("WeCom QR response missing scode or auth_url.");
  return body;
}

async function pollWecomQrStatus(
  flow: QrBindingFlow,
): Promise<WecomQrQueryResponse> {
  if (!flow.scode) throw new Error("WeCom QR flow is missing scode.");
  const body = await fetchQrJson<WecomQrQueryResponse>(
    `${WECOM_QR_QUERY_URL}?scode=${encodeURIComponent(flow.scode)}`,
    10_000,
  );
  if (body.errcode != null && body.errcode !== 0)
    throw new Error(`WeCom status error ${body.errcode}: ${body.errmsg || ""}`);
  return body;
}

export async function startWecomQrBindingFlow(): Promise<QrBindingFlow> {
  const qrResponse = await fetchWecomQrCode();
  const now = Date.now();
  return {
    id: qrBindingFlowID("wecom"),
    channel: "wecom",
    status: "wait",
    scode: qrResponse.data?.scode,
    qrDataURI: await generateQrDataURI(qrResponse.data?.auth_url || ""),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + QR_BINDING_FLOW_TTL_MS,
  };
}

export async function pollWecomQrBindingFlow(
  flow: QrBindingFlow,
  saveChannel: SaveWecomChannel,
): Promise<QrBindingFlowResponse> {
  if (isTerminalQrStatus(flow.status)) return qrBindingFlowResponse(flow);
  try {
    const response = await pollWecomQrStatus(flow);
    const status = normalizeQrBindingStatus(response.data?.status);
    if (status === "confirmed") {
      const botId = response.data?.bot_info?.botid;
      const secret = response.data?.bot_info?.secret;
      if (!botId || !secret) {
        flow.status = "error";
        flow.error =
          "WeCom login confirmed but response is missing bot credentials.";
      } else {
        await saveChannel({
          bot_id: botId,
          secret,
          websocket_url: WECOM_DEFAULT_WEBSOCKET_URL,
        });
        flow.status = "confirmed";
        flow.botId = botId;
        delete flow.qrDataURI;
      }
      flow.updatedAt = Date.now();
    } else if (status === "expired" || status === "scaned") {
      flow.status = status;
      flow.updatedAt = Date.now();
    }
  } catch {
    flow.updatedAt = Date.now();
  }
  return qrBindingFlowResponse(flow);
}
