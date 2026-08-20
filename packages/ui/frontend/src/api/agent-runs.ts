import { launcherFetch } from "@/api/http"

export type AgentRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"

export type VerificationEvidenceKind =
  | "command"
  | "file"
  | "api"
  | "manual"
  | "metric"

export interface VerificationEvidence {
  kind: VerificationEvidenceKind
  summary: string
  ok: boolean
  source?:
    | "planner"
    | "executor"
    | "verifier"
    | "model"
    | "tool"
    | "test"
    | "build"
    | "smoke"
    | "dashboard"
    | "manual"
  phase?: "planner" | "executor" | "verifier"
  capturedAt?: string
  metadata?: Record<string, unknown>
  modelCall?: Record<string, unknown>
  toolCall?: Record<string, unknown>
  permission?: Record<string, unknown>
  data?: Record<string, unknown>
}

export interface TaskGraphStep {
  id: string
  title: string
  dependsOn: string[]
  phase?: "planner" | "executor" | "verifier"
  status: AgentRunStatus
  startedAt?: string
  completedAt?: string
  attempts: number
  evidence: VerificationEvidence[]
  error?: {
    code: string
    category: string
    message: string
    retryable: boolean
    remediation?: string
  }
}

export interface AgentRun {
  id: string
  objective: string
  status: AgentRunStatus
  createdAt: string
  updatedAt: string
  steps: TaskGraphStep[]
  timeline?: Array<{
    id: string
    at: string
    stepId?: string
    phase?: "planner" | "executor" | "verifier"
    source: string
    summary: string
    ok?: boolean
    metadata?: Record<string, unknown>
  }>
  contextBudget?: Record<string, unknown>
  retrievalDiagnostics?: Record<string, unknown>
}

export interface AgentRunExportBundle {
  schemaVersion: 1 | 2
  exportedAt: string
  run: AgentRun
  replay?: {
    objective: string
    steps: Array<{
      id: string
      title: string
      phase?: "planner" | "executor" | "verifier"
      evidenceCount: number
      status: AgentRunStatus
    }>
  }
}

export interface CreateAgentRunPayload {
  objective: string
  steps?: string[]
}

interface AgentRunsResponse {
  runs: AgentRun[]
}

interface AgentRunResponse {
  run: AgentRun
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await launcherFetch(path, options)
  if (!res.ok) {
    let message = `API error: ${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error?.trim()) message = body.error
    } catch {
      // ignore invalid body
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export async function listAgentRuns(limit = 100): Promise<AgentRunsResponse> {
  return request<AgentRunsResponse>(
    `/api/enhancements/agent/runs?limit=${encodeURIComponent(String(limit))}`,
  )
}

export async function getAgentRun(runId: string): Promise<AgentRunResponse> {
  return request<AgentRunResponse>(
    `/api/enhancements/agent/runs/${encodeURIComponent(runId)}`,
  )
}

export async function createAgentRun(
  payload: CreateAgentRunPayload,
): Promise<AgentRunResponse> {
  return request<AgentRunResponse>("/api/enhancements/agent/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

export async function exportAgentRun(
  runId: string,
): Promise<AgentRunExportBundle> {
  return request<AgentRunExportBundle>(
    `/api/enhancements/agent/runs/${encodeURIComponent(runId)}/export`,
  )
}
