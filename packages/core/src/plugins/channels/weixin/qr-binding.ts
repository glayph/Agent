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

const WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const WEIXIN_BOT_TYPE = "3";

interface WeixinQrResponse {
  errcode?: number;
  errmsg?: string;
  qrcode?: string;
  qrcode_img_content?: string;
}

interface WeixinQrStatusResponse {
  errcode?: number;
  errmsg?: string;
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export type SaveWeixinChannel = (
  settings: Record<string, unknown>,
) => Promise<void>;

function weixinApiURL(
  baseURL: string,
  pathName: string,
  query: Record<string, string>,
): string {
  const parsed = new URL(
    pathName,
    baseURL.endsWith("/") ? baseURL : `${baseURL}/`,
  );
  for (const [key, value] of Object.entries(query))
    parsed.searchParams.set(key, value);
  return parsed.toString();
}

async function fetchWeixinQrCode(proxy?: string): Promise<WeixinQrResponse> {
  const body = await fetchQrJson<WeixinQrResponse>(
    weixinApiURL(WEIXIN_BASE_URL, "/ilink/bot/get_bot_qrcode", {
      bot_type: WEIXIN_BOT_TYPE,
    }),
    15_000,
    { proxy },
  );
  if (body.errcode != null && body.errcode !== 0)
    throw new Error(`Weixin QR error ${body.errcode}: ${body.errmsg || ""}`);
  if (!body.qrcode || !body.qrcode_img_content)
    throw new Error("Weixin QR response missing qrcode or image content.");
  return body;
}

async function pollWeixinQrStatus(
  flow: QrBindingFlow,
  proxy?: string,
): Promise<WeixinQrStatusResponse> {
  if (!flow.qrcode) throw new Error("Weixin QR flow is missing qrcode token.");
  const body = await fetchQrJson<WeixinQrStatusResponse>(
    weixinApiURL(
      flow.pollBaseURL || WEIXIN_BASE_URL,
      "/ilink/bot/get_qrcode_status",
      { qrcode: flow.qrcode },
    ),
    10_000,
    { proxy },
  );
  if (body.errcode != null && body.errcode !== 0)
    throw new Error(
      `Weixin status error ${body.errcode}: ${body.errmsg || ""}`,
    );
  return body;
}

export async function startWeixinQrBindingFlow(
  proxy?: string,
): Promise<QrBindingFlow> {
  const qrResponse = await fetchWeixinQrCode(proxy);
  const now = Date.now();
  return {
    id: qrBindingFlowID("weixin"),
    channel: "weixin",
    status: "wait",
    qrcode: qrResponse.qrcode,
    qrDataURI: await generateQrDataURI(qrResponse.qrcode_img_content || ""),
    pollBaseURL: WEIXIN_BASE_URL,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + QR_BINDING_FLOW_TTL_MS,
  };
}

export async function pollWeixinQrBindingFlow(
  flow: QrBindingFlow,
  proxy: string | undefined,
  saveChannel: SaveWeixinChannel,
): Promise<QrBindingFlowResponse> {
  if (isTerminalQrStatus(flow.status)) return qrBindingFlowResponse(flow);
  try {
    const response = await pollWeixinQrStatus(flow, proxy);
    const status = normalizeQrBindingStatus(response.status);
    if (response.redirect_host) {
      flow.pollBaseURL = response.redirect_host.includes("://")
        ? response.redirect_host
        : `https://${response.redirect_host}`;
    }
    if (status === "confirmed") {
      if (!response.bot_token || !response.ilink_bot_id) {
        flow.status = "error";
        flow.error =
          "Weixin login confirmed but response is missing bot credentials.";
      } else {
        await saveChannel({
          token: response.bot_token,
          account_id: response.ilink_bot_id,
          ...(response.baseurl ? { base_url: response.baseurl } : {}),
          ...(response.ilink_user_id
            ? { ilink_user_id: response.ilink_user_id }
            : {}),
        });
        flow.status = "confirmed";
        flow.accountId = response.ilink_bot_id;
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
