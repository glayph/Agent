import { launcherFetch } from "@/api/http"

// API client for miki Channel configuration.

interface mikiInfoResponse {
  ws_url: string
  enabled: boolean
  configured?: boolean
}

interface mikiSetupResponse {
  ws_url: string
  enabled: boolean
  configured?: boolean
  changed: boolean
}

const BASE_URL = ""

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await launcherFetch(`${BASE_URL}${path}`, options)
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export async function getmikiInfo(): Promise<mikiInfoResponse> {
  return request<mikiInfoResponse>("/api/miki/info")
}

export async function regenmikiToken(): Promise<mikiInfoResponse> {
  return request<mikiInfoResponse>("/api/miki/token", { method: "POST" })
}

export async function setupmiki(): Promise<mikiSetupResponse> {
  return request<mikiSetupResponse>("/api/miki/setup", { method: "POST" })
}

export type { mikiInfoResponse, mikiSetupResponse }
