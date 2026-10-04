import { launcherFetch } from "@/api/http"

export const PLATFORM_PROVIDERS = [
  "facebook",
  "youtube",
  "x",
  "telegram",
  "whatsapp",
  "instagram",
  "linkedin",
  "discord",
  "slack",
  "webhook",
] as const

export type PlatformProvider = (typeof PLATFORM_PROVIDERS)[number]

export interface PlatformDescriptor {
  id: PlatformProvider
  label: string
  requiredScopes?: string[]
}

export interface PlatformsResponse {
  platforms: PlatformDescriptor[]
}

export interface BrowserConnectionResponse {
  browser: { url: string }
  provider: PlatformProvider
}

const fallbackPlatforms: PlatformsResponse = {
  platforms: PLATFORM_PROVIDERS.map((id) => ({
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
  })),
}

export async function listPlatforms(): Promise<PlatformsResponse> {
  try {
    const response = await launcherFetch("/api/automations/platforms")
    if (response.ok) return (await response.json()) as PlatformsResponse
  } catch {
    // The dashboard remains usable while the optional automation service is offline.
  }
  return fallbackPlatforms
}

export async function completeConnectionFromOpaqueToken(
  provider: PlatformProvider,
  label: string,
  token: string,
  requiredScopes?: string[],
): Promise<unknown> {
  const response = await launcherFetch("/api/automations/connections/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, label, token, requiredScopes }),
  })
  if (!response.ok) throw new Error("Platform token could not be stored.")
  return response.json()
}

export async function startBrowserPlatformConnection(
  provider: PlatformProvider,
): Promise<BrowserConnectionResponse> {
  const response = await launcherFetch(
    `/api/automations/connections/browser/${encodeURIComponent(provider)}`,
    { method: "POST" },
  )
  if (!response.ok) throw new Error("Browser setup is not available yet.")
  return (await response.json()) as BrowserConnectionResponse
}
