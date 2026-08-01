import { launcherFetch } from "@/api/http"

// API client for hiro Channel configuration.

interface hiroInfoResponse {
  ws_url: string
  enabled: boolean
  configured?: boolean
}

interface hiroSetupResponse {
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

export async function gethiroInfo(): Promise<hiroInfoResponse> {
  return request<hiroInfoResponse>("/api/hiro/info")
}

export async function regenhiroToken(): Promise<hiroInfoResponse> {
  return request<hiroInfoResponse>("/api/hiro/token", { method: "POST" })
}

export async function setuphiro(): Promise<hiroSetupResponse> {
  return request<hiroSetupResponse>("/api/hiro/setup", { method: "POST" })
}

export type { hiroInfoResponse, hiroSetupResponse }
