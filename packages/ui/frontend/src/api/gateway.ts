import { launcherFetch } from "@/api/http"

// API client for gateway process management.

interface GatewayStatusResponse {
  gateway_status: "running" | "starting" | "restarting" | "stopping" | "stopped" | "error"
  gateway_start_allowed?: boolean
  gateway_start_reason?: string
  gateway_restart_required?: boolean
  runtime_apply_status?: "applied" | "pending_restart" | "failed"
  runtime_apply_error?: string
  pending_restart_fields?: string[]
  pid?: number
  boot_default_model?: string
  config_default_model?: string
  [key: string]: unknown
}

interface GatewayLogsResponse {
  logs?: string[]
  log_total?: number
  log_run_id?: number
}

interface GatewayActionResponse {
  status: "ok" | "running" | "reloaded" | "pending_restart" | "pending_shutdown" | "failed" | string
  supported?: boolean
  pid?: number
  log_total?: number
  log_run_id?: number
  gateway_restart_required?: boolean
  runtime_apply_status?: "applied" | "pending_restart" | "failed"
  runtime_apply_error?: string
  pending_restart_fields?: string[]
  message?: string
  error?: string
}

interface RuntimeReloadResponse {
  status: "applied" | "pending_restart" | "failed"
  applied: boolean
  pending_restart: boolean
  gateway_restart_required: boolean
  pending_restart_fields?: string[]
  error?: string
}

const BASE_URL = ""

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await launcherFetch(`${BASE_URL}${path}`, options)
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export async function getGatewayStatus(): Promise<GatewayStatusResponse> {
  return request<GatewayStatusResponse>("/api/gateway/status")
}

export async function getGatewayLogs(options?: {
  offset?: number
  run_id?: number
}): Promise<GatewayLogsResponse> {
  const params = new URLSearchParams()
  if (options?.offset !== undefined) {
    params.set("offset", options.offset.toString())
  }
  if (options?.run_id !== undefined) {
    params.set("run_id", options.run_id.toString())
  }
  const queryString = params.toString() ? `?${params.toString()}` : ""
  return request<GatewayLogsResponse>(`/api/gateway/logs${queryString}`)
}

export async function startGateway(): Promise<GatewayActionResponse> {
  return request<GatewayActionResponse>("/api/gateway/start", {
    method: "POST",
  })
}

export async function stopGateway(): Promise<GatewayActionResponse> {
  return request<GatewayActionResponse>("/api/gateway/shutdown", {
    method: "POST",
  })
}

export async function restartGateway(): Promise<GatewayActionResponse> {
  return request<GatewayActionResponse>("/api/gateway/restart", {
    method: "POST",
  })
}

export async function clearGatewayLogs(): Promise<GatewayActionResponse> {
  // Log management is owned by the Node Gateway; keep this client on the
  // canonical /api/gateway contract.
  return request<GatewayActionResponse>("/api/gateway/logs/clear", {
    method: "POST",
  })
}

export async function reloadRuntime(): Promise<RuntimeReloadResponse> {
  return request<RuntimeReloadResponse>("/api/runtime/reload", {
    method: "POST",
  })
}

export type {
  GatewayStatusResponse,
  GatewayLogsResponse,
  GatewayActionResponse,
  RuntimeReloadResponse,
}
