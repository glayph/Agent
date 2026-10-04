import { launcherFetch } from "@/api/http"

export interface AgentRunUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface AgentRun {
  id: string
  session_id: string | null
  lane: "chat" | "heartbeat" | "autonomy" | "control" | string
  source: string
  status: "running" | "completed" | "failed" | "cancelled" | "limit_reached" | string
  model: string | null
  goal: string | null
  final_text: string | null
  error: string | null
  turns: number
  tool_calls: number
  usage: AgentRunUsage
  started_at: string
  finished_at: string | null
  created_at: string
}

export interface AgentRunsListResponse {
  runs: AgentRun[]
  total: number
  limit: number
  offset: number
}

export interface ListRunsParams {
  q?: string
  status?: string
  lane?: string
  page?: number
  limit?: number
}

export async function listRuns(params: ListRunsParams = {}): Promise<AgentRunsListResponse> {
  const search = new URLSearchParams()
  if (params.q) search.set("q", params.q)
  if (params.status && params.status !== "all") search.set("status", params.status)
  if (params.lane && params.lane !== "all") search.set("lane", params.lane)
  if (params.page && params.page > 0) search.set("page", String(params.page))
  if (params.limit) search.set("limit", String(params.limit))
  const qs = search.toString()
  const res = await launcherFetch(`/api/runs${qs ? `?${qs}` : ""}`, {
    showErrorToast: true,
  })
  if (!res.ok) {
    throw new Error(`Failed to load runs (${res.status})`)
  }
  return (await res.json()) as AgentRunsListResponse
}

export async function getRun(id: string): Promise<AgentRun> {
  const res = await launcherFetch(`/api/runs/${encodeURIComponent(id)}`, {
    showErrorToast: true,
  })
  if (!res.ok) {
    throw new Error(`Failed to load run (${res.status})`)
  }
  return (await res.json()) as AgentRun
}
