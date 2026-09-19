import { launcherFetch } from "./http"

export type PluginFamily = "provider" | "channel" | "capability"
export type PluginRuntimeStatus =
  | "functional"
  | "partial"
  | "metadata_only"
  | "config_only"
  | "disabled"
  | "unsupported"

export type PluginPermission =
  | "network"
  | "filesystem-read"
  | "filesystem-write"
  | "secrets"
  | "shell"
  | "browser"
  | "computer-use"
  | "mcp"
  | "agent-delegation"

export interface PluginManifest {
  id: string
  displayName: string
  version: string
  apiVersion: string
  capabilities: string[]
  runtimeStatus: PluginRuntimeStatus
  description?: string
  configKey?: string
  requiredConfig?: string[]
  secretFields?: string[]
  permissions?: PluginPermission[]
  platform?: Array<"win32" | "linux" | "darwin" | "any">
  metadata?: Record<string, unknown>
}

export interface BuiltinPluginManifestResponse {
  manifests: PluginManifest[]
  total: number
}

export interface PluginHealth {
  ok: boolean
  status: PluginRuntimeStatus
  latencyMs?: number
  message?: string
  details?: Record<string, unknown>
}

export interface PluginHealthResponse {
  health: Record<string, PluginHealth>
  total: number
}

type ApiEnvelope<T> = {
  success: boolean
  data: T
  error?: string
  detail?: string
}

function unwrap<T>(response: T | ApiEnvelope<T>): T {
  if (
    typeof response === "object" &&
    response !== null &&
    "success" in response &&
    "data" in response &&
    typeof response.success === "boolean"
  ) {
    return response.data
  }
  return response as T
}

async function request<T>(path: string): Promise<T> {
  const response = await launcherFetch(path)
  if (!response.ok) {
    throw new Error(`Plugin API request failed: ${response.status}`)
  }
  const body = (await response.json()) as T | ApiEnvelope<T>
  return unwrap(body)
}

export async function getPluginManifests(): Promise<BuiltinPluginManifestResponse> {
  return request<BuiltinPluginManifestResponse>(
    "/api/skills/plugins?action=capabilities",
  )
}

export async function getPluginHealth(): Promise<PluginHealthResponse> {
  return request<PluginHealthResponse>(
    "/api/skills/plugins?action=capability-health",
  )
}
