import { launcherFetch } from "@/api/http"

export type ChannelConfig = Record<string, unknown>
export type AppConfig = Record<string, unknown>

export interface SupportedChannel {
  name: string
  display_name?: string
  config_key: string
  variant?: string
  runtime_status?: "functional" | "partial" | "config_only"
  runtime_note?: string
}

export interface ChannelConfigResponse {
  config: ChannelConfig
  configured_secrets: string[]
  config_key: string
  variant?: string
}

export interface ChannelRuntimeProbeCheck {
  id: string
  status: "pass" | "warn" | "fail"
  message: string
}

export interface ChannelRuntimeProbeResponse {
  channel: string
  display_name?: string
  runtime_status: "functional" | "partial" | "config_only"
  probe_status:
    | "ready"
    | "disabled"
    | "needs_config"
    | "auth_failed"
    | "webhook_failed"
    | "rate_limited"
    | "runtime_error"
    | "partial"
    | "not_implemented"
  agent_connected: boolean
  enabled: boolean
  configured: boolean
  missing_fields: string[]
  checks: ChannelRuntimeProbeCheck[]
  check_mode: "mock" | "sandbox" | "live"
  latency_ms: number
  send_check?: {
    status: "passed" | "skipped" | "failed"
    mode: "mock" | "sandbox" | "live"
    message: string
    latency_ms: number
  }
  failure_code?: string
  next_steps: string[]
  setup_checklist: string[]
  checked_at: string
}

export type QrBindingChannel = "weixin" | "wecom"
export type QrBindingStatus =
  | "wait"
  | "scaned"
  | "scanned"
  | "confirmed"
  | "expired"
  | "error"

export interface QrBindingFlowResponse {
  flow_id: string
  status: QrBindingStatus | string
  qr_data_uri?: string
  account_id?: string
  bot_id?: string
  error?: string
}

interface ChannelsCatalogResponse {
  channels: SupportedChannel[]
}

interface ConfigActionResponse {
  status: string
  errors?: string[]
}

const BASE_URL = ""

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await launcherFetch(`${BASE_URL}${path}`, options)
  if (!res.ok) {
    let message = `API error: ${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as {
        error?: string
        errors?: string[]
        status?: string
      }
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        message = body.errors.join("; ")
      } else if (typeof body.error === "string" && body.error.trim() !== "") {
        message = body.error
      }
    } catch {
      // Keep default fallback message if response body is not JSON.
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export async function getChannelsCatalog(): Promise<ChannelsCatalogResponse> {
  return request<ChannelsCatalogResponse>("/api/channels/catalog")
}

export async function getAppConfig(): Promise<AppConfig> {
  return request<AppConfig>("/api/config")
}

export async function getChannelConfig(
  channelName: string,
): Promise<ChannelConfigResponse> {
  return request<ChannelConfigResponse>(
    `/api/channels/${encodeURIComponent(channelName)}/config`,
  )
}

export async function probeChannelRuntime(
  channelName: string,
  mode?: ChannelRuntimeProbeResponse["check_mode"],
): Promise<ChannelRuntimeProbeResponse> {
  const query = mode ? `?mode=${encodeURIComponent(mode)}` : ""
  return request<ChannelRuntimeProbeResponse>(
    `/api/channels/${encodeURIComponent(channelName)}/probe${query}`,
  )
}

function qrBindingFlowPath(channel: QrBindingChannel, flowId?: string): string {
  const encodedFlowId = flowId ? `/${encodeURIComponent(flowId)}` : ""
  return `/api/${channel}/flows${encodedFlowId}`
}

export async function startQrBindingFlow(
  channel: QrBindingChannel,
): Promise<QrBindingFlowResponse> {
  return request<QrBindingFlowResponse>(qrBindingFlowPath(channel), {
    method: "POST",
  })
}

export async function pollQrBindingFlow(
  channel: QrBindingChannel,
  flowId: string,
): Promise<QrBindingFlowResponse> {
  return request<QrBindingFlowResponse>(qrBindingFlowPath(channel, flowId))
}

export async function patchAppConfig(
  patch: Record<string, unknown>,
): Promise<ConfigActionResponse> {
  return request<ConfigActionResponse>("/api/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
}

export async function resetAppConfig(): Promise<ConfigActionResponse> {
  return request<ConfigActionResponse>("/api/config/reset", {
    method: "POST",
  })
}

export type { ChannelsCatalogResponse, ConfigActionResponse }
