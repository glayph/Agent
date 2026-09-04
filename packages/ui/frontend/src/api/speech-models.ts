import { launcherFetch } from "@/api/http"

export type SpeechModelTransport = "endpoint" | "cli"

export interface SpeechToTextModel {
  id: string
  name: string
  transport: SpeechModelTransport
  enabled: boolean
  endpoint?: string
  executable?: string
  model?: string
}

export interface SpeechToTextSettings {
  language: string
  max_audio_seconds: number
  max_file_mb: number
  timeout_ms: number
  concurrency: number
  retain_audio: boolean
}

export interface VoiceCatalogModel {
  id: string
  name: string
  description: string
  languages: string
  size: string
  sha1: string
  modelUrl: string
  licenseUrl: string
  transport: "cli" | "endpoint"
  installed: boolean
  active: boolean
}

export interface VoiceRuntimeStatus {
  installed: boolean
  enabled: boolean
  activeModelId: string | null
  activeModelName: string | null
  transport: "cli" | "endpoint" | null
  runtimeConfigured: boolean
  healthy: boolean
  reason: string
  modelDirectory: string
  executable?: string
  endpoint?: string
  catalog: VoiceCatalogModel[]
}

export interface SpeechModelsResponse {
  provider: "whisper.cpp"
  enabled: boolean
  active_model_id: string | null
  models: SpeechToTextModel[]
  settings: SpeechToTextSettings
  local_runtime?: VoiceRuntimeStatus
}

export interface SpeechModelActionResponse extends SpeechModelsResponse {
  status: string
  local_runtime?: VoiceRuntimeStatus
  approval_request_id?: string
  plan?: Record<string, unknown>
  outcome?: Record<string, unknown>
  gateway_restart_required?: boolean
  runtime_apply_status?: string
  runtime_apply_error?: string
  pending_restart_fields?: string[]
}

const BASE_URL = ""

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await launcherFetch(`${BASE_URL}${path}`, options)
  if (!response.ok) {
    let detail = ""
    try {
      detail = await response.text()
    } catch {
      // Ignore response parsing failures and use the HTTP status below.
    }
    throw new Error(
      detail || `API error: ${response.status} ${response.statusText}`,
    )
  }
  return response.json() as Promise<T>
}

export async function getSpeechModels(): Promise<SpeechModelsResponse> {
  return request<SpeechModelsResponse>("/api/speech-to-text/models")
}

export async function getVoiceRuntimeStatus(): Promise<VoiceRuntimeStatus> {
  return request<VoiceRuntimeStatus>("/api/speech-to-text/status")
}

export async function installVoiceModel(
  modelId: string,
  approvalRequestId?: string,
  plan?: Record<string, unknown>,
): Promise<SpeechModelActionResponse> {
  return request<SpeechModelActionResponse>("/api/speech-to-text/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: modelId,
      ...(approvalRequestId ? { approval_request_id: approvalRequestId } : {}),
      ...(plan ? { plan } : {}),
    }),
  })
}

export async function healthCheckVoiceModel(): Promise<SpeechModelActionResponse> {
  return request<SpeechModelActionResponse>("/api/speech-to-text/health", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  })
}

export async function updateSpeechConfig(
  input: Partial<SpeechToTextSettings> & {
    enabled?: boolean
    active_model_id?: string | null
  },
): Promise<SpeechModelActionResponse> {
  return request<SpeechModelActionResponse>("/api/speech-to-text/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
}

export async function addSpeechModel(
  model: Omit<SpeechToTextModel, "enabled"> & {
    enabled?: boolean
    set_active?: boolean
  },
): Promise<SpeechModelActionResponse> {
  return request<SpeechModelActionResponse>("/api/speech-to-text/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(model),
  })
}

export async function updateSpeechModel(
  id: string,
  model: Partial<SpeechToTextModel>,
): Promise<SpeechModelActionResponse> {
  return request<SpeechModelActionResponse>(
    `/api/speech-to-text/models/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(model),
    },
  )
}

export async function deleteSpeechModel(
  id: string,
): Promise<SpeechModelActionResponse> {
  return request<SpeechModelActionResponse>(
    `/api/speech-to-text/models/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  )
}

export async function activateSpeechModel(
  modelId: string,
): Promise<SpeechModelActionResponse> {
  return request<SpeechModelActionResponse>(
    "/api/speech-to-text/models/active",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: modelId }),
    },
  )
}
