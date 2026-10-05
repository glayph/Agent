import { launcherFetch } from "@/api/http"
import type { CredentialStatus } from "@/features/credentials/components/provider-status-line"

export interface CredentialProviderStatus {
  status: CredentialStatus
  configured: boolean
  authMethod: string
  apiKeyMask?: string
}

export interface CredentialStatusResponse {
  providers: {
    gemini: CredentialProviderStatus
    llama: CredentialProviderStatus
  }
}

export async function getCredentialStatus(): Promise<CredentialStatusResponse> {
  const response = await launcherFetch("/api/credentials/status")
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `API error: ${response.status}`)
  }
  return response.json() as Promise<CredentialStatusResponse>
}
