import { launcherFetch } from "./http"

export type MemoryStats = {
  chunks: number
  edges: number
  postings: number
  retrievals: number
  byRegion: Array<{ region: string; count: number }>
}

export type MemoryChunk = {
  id: string
  scope_key: string
  region: string
  content: string
  summary: string
  provenance: string
  confidence: number
  importance: number
  created_at: string
  updated_at: string
  access_count: number
  status: string
  metadata?: Record<string, unknown>
}

export type MemoryItem = {
  id: string
  text: string
  summary?: string
  region: string
  provenance: string
  confidence: number
  importance: number
  score: number
  lexical: number
  semantic: number
  depth: number
  sourceType?: string
  sourceReference?: string | null
  via?: Record<string, unknown> | null
}

export type MemorySearchResult = {
  query: string
  scope: Record<string, string>
  result: {
    items: MemoryItem[]
    text: string
    trace: Record<string, unknown>
    stats: {
      candidateCount: number
      selectedCount: number
      tokensUsed: number
      maxTokens: number
      latencyMs: number
      fallbackReason?: string | null
    }
  }
}

async function request<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await launcherFetch(input, init)
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string
  }
  if (!response.ok)
    throw new Error(payload.error || `Request failed (${response.status})`)
  return payload
}

export async function getMemoryStats(): Promise<{
  scope: Record<string, string>
  stats: MemoryStats
}> {
  return request("/api/memory/stats")
}

export async function listMemoryChunks(
  options: { region?: string; limit?: number } = {},
) {
  const params = new URLSearchParams()
  if (options.region) params.set("region", options.region)
  if (options.limit) params.set("limit", String(options.limit))
  return request<{ scope: Record<string, string>; chunks: MemoryChunk[] }>(
    `/api/memory/chunks?${params}`,
  )
}

export async function searchMemory(
  query: string,
  options: { maxSelected?: number; maxDepth?: number; maxTokens?: number } = {},
) {
  const params = new URLSearchParams({ q: query })
  if (options.maxSelected)
    params.set("maxSelected", String(options.maxSelected))
  if (options.maxDepth !== undefined)
    params.set("maxDepth", String(options.maxDepth))
  if (options.maxTokens) params.set("maxTokens", String(options.maxTokens))
  return request<MemorySearchResult>(`/api/memory/search?${params}`)
}

export async function inspectMemoryChunk(chunkId: string) {
  return request<{
    scope: Record<string, string>
    chunk: MemoryChunk & { edges: Array<Record<string, unknown>> }
  }>(`/api/memory/chunks/${encodeURIComponent(chunkId)}`)
}

export async function reindexMemory() {
  return request<{ result: { reindexed: number } }>("/api/memory/reindex", {
    method: "POST",
  })
}

export async function forgetMemoryChunk(chunkId: string) {
  return request<{ result: { forgotten: boolean; chunkId: string } }>(
    `/api/memory/chunks/${encodeURIComponent(chunkId)}/forget`,
    { method: "POST" },
  )
}
