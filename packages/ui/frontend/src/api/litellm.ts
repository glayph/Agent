import { launcherFetch } from "@/api/http"

export interface LiteLLMModelMapping {
  modelName: string
  litellmModel: string
  provider: string
}

export interface LiteLLMStatus {
  configured: boolean
  healthy: boolean
  status: "healthy" | "unreachable" | "unconfigured" | string
  base_url: string
  config_path: string
  config_exists: boolean
  log_path: string
  model_count: number
  models: LiteLLMModelMapping[]
  models_endpoint_count?: number
  error?: string
  gateway_restart_required?: boolean
}

export interface LiteLLMGatewayStatus {
  status: string
  healthy: boolean
  pid?: number | null
  started_at?: string | null
  base_url: string
  port: number
  executable: string
  config_path: string
  config_exists: boolean
  log_path: string
  models_endpoint_count?: number
  last_exit_code?: number | null
  error?: string
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await launcherFetch(path, options)
  if (!res.ok) {
    let detail = ""
    try {
      detail = await res.text()
    } catch {
      // ignore
    }
    throw new Error(detail || `API error: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export async function getLiteLLMStatus(): Promise<LiteLLMStatus> {
  return request<LiteLLMStatus>("/api/litellm/status")
}

export async function syncLiteLLMConfig(): Promise<{
  status: string
  config_path: string
  base_url: string
  model_count: number
  gateway_restart_required: boolean
}> {
  return request("/api/litellm/sync", { method: "POST" })
}

export async function restartLiteLLM(): Promise<LiteLLMGatewayStatus> {
  try {
    const status = await request<LiteLLMGatewayStatus>("/gateway/litellm/restart", {
      method: "POST",
    })
    await request("/api/gateway/restart", { method: "POST" })
    return status
  } catch {
    await request("/api/litellm/restart", { method: "POST" })
    throw new Error("LiteLLM restart requires the gateway process.")
  }
}
