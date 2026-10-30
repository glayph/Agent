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
  source?: "live_probe" | "manifest_only" | "not_checked"
  checkedAt?: string
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
    typeof response.success === "boolean"
  ) {
    const envelope = response as ApiEnvelope<T>
    if (!envelope.success) {
      throw new Error(envelope.error || envelope.detail || "Plugin API request failed.")
    }
    if (!("data" in response)) {
      throw new Error("Plugin API returned a success envelope without data.")
    }
    return envelope.data
  }
  return response as T
}

async function request<T>(path: string): Promise<T> {
  const response = await launcherFetch(path)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const envelope = body as Partial<ApiEnvelope<unknown>> | undefined
    throw new Error(
      envelope?.error || envelope?.detail || `Plugin API request failed: ${response.status}`,
    )
  }
  if (body === undefined) throw new Error("Plugin API returned an empty response.")
  return unwrap(body as T | ApiEnvelope<T>)
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

export interface InstalledPlugin {
  id: string
  version: string
  digest: string
  source: string
  enabled: boolean
  lifecycle_state: string
  runtime_status: string
  manifest: PluginManifest & { entrypoint?: string; dependencies?: string[] }
  requested_permissions: PluginPermission[]
  granted_permissions: PluginPermission[]
  installed_at: string
  updated_at: string
  last_error_code?: string | null
  sandbox_supported: boolean
}

export interface InstalledPluginResponse {
  plugins: InstalledPlugin[]
  total: number
  sandbox_supported: boolean
}

async function requestMutation<T>(path: string, init: RequestInit): Promise<T> {
  const response = await launcherFetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } })
  let body: unknown
  try { body = await response.json() } catch { body = undefined }
  if (!response.ok) {
    const record = body as { error?: unknown; permissions?: unknown; dependents?: unknown } | undefined
    const code = typeof record?.error === "string" ? record.error : `Plugin API request failed: ${response.status}`
    const details = Array.isArray(record?.permissions) ? ` (${record.permissions.join(", ")})` : Array.isArray(record?.dependents) ? ` (${record.dependents.join(", ")})` : ""
    throw new Error(`${code}${details}`)
  }
  if (!body || typeof body !== "object") throw new Error("Plugin API returned an empty response.")
  return body as T
}

export async function getInstalledPlugins(): Promise<InstalledPluginResponse> {
  return request<InstalledPluginResponse>("/api/plugins/installed")
}

export interface TrustedPluginPackage {
  id: string
  manifest: PluginManifest
  description: string
  digest: string
  installed: boolean
  trusted: true
}

export async function getTrustedPluginMarketplace(): Promise<{ packages: TrustedPluginPackage[]; total: number; source: string; unavailable_reason?: string }> {
  return request("/api/plugins/marketplace")
}

export async function installTrustedPluginPackage(id: string): Promise<InstalledPlugin> {
  const result = await requestMutation<{ plugin: InstalledPlugin }>("/api/plugins/install", {
    method: "POST",
    body: JSON.stringify({ registry_id: id }),
  })
  return result.plugin
}

export async function installPluginArchive(file: File): Promise<InstalledPlugin> {
  if (file.size <= 0 || file.size > 8 * 1024 * 1024) throw new Error("archive_size_invalid")
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)))
  }
  const archiveBase64 = btoa(binary)
  const digestBytes = await crypto.subtle.digest("SHA-256", bytes)
  const sha256 = Array.from(new Uint8Array(digestBytes), (part) => part.toString(16).padStart(2, "0")).join("")
  const result = await requestMutation<{ plugin: InstalledPlugin }>("/api/plugins/install", {
    method: "POST",
    body: JSON.stringify({ archive_base64: archiveBase64, sha256 }),
  })
  return result.plugin
}

export async function updateInstalledPlugin(id: string, input: { enabled?: boolean; granted_permissions?: PluginPermission[] }): Promise<InstalledPlugin> {
  const result = await requestMutation<{ plugin: InstalledPlugin }>(`/api/plugins/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
  return result.plugin
}

export async function uninstallInstalledPlugin(id: string): Promise<void> {
  await requestMutation<{ removed: boolean }>(`/api/plugins/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Confirm-Plugin-Uninstall": id },
  })
}

export async function probeInstalledPluginHealth(id: string): Promise<{ ok: boolean; status?: string; source: string; checked_at: string; error?: string }> {
  return requestMutation(`/api/plugins/${encodeURIComponent(id)}/health`, { method: "POST", body: "{}" })
}
