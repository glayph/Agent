import { launcherFetch } from "./http"

export type ControlRisk = "read" | "config_write" | "install" | "service" | "destructive"
export type ControlRequestContext = { origin?: "local" | "dashboard" | "telegram" | "mcp" | "api" | "system"; actor?: string; requestId?: string; sessionId?: string }

export interface ControlCapability {
  id: string
  label: string
  description: string
  risk: ControlRisk
  platforms: string[]
  readOnly: boolean
  actions: string[]
  supportsApproval: boolean
  limitations: string[]
}

export interface ControlStateResponse {
  state: Record<string, unknown>
}

export interface ControlPlan {
  operationId: string
  capability: string
  action: string
  risk: ControlRisk
  status: string
  approvalRequired: boolean
  sanitizedInput: Record<string, unknown>
  steps: Array<Record<string, unknown>>
  evidence: Array<Record<string, unknown>>
}

export interface ApprovalRequest {
  id: string
  runId: string
  actor: string
  action: string
  resource: string
  risk: string
  reason: string
  status: string
  createdAt: string
  expiresAt: string
}

export interface ControlOutcome {
  operationId: string
  status: string
  ok: boolean
  changed: boolean
  approvalRequired: boolean
  pendingRestart: boolean
  capability: string
  action: string
  state?: Record<string, unknown>
  evidence: Array<Record<string, unknown>>
  error?: string
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await launcherFetch(path, init)
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) {
    throw new Error(body.error || `Control request failed (${response.status})`)
  }
  return body
}

export async function getApprovalRequests(): Promise<{ requests: ApprovalRequest[] }> {
  return requestJson("/api/control/approvals")
}

export async function approveApprovalRequest(id: string, decidedBy = "dashboard-operator"): Promise<{ request: ApprovalRequest }> {
  return requestJson(`/api/control/approvals/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decidedBy }),
  })
}

export async function getControlCapabilities(): Promise<{
  capabilities: ControlCapability[]
}> {
  return requestJson("/api/control/capabilities")
}

export async function getControlState(): Promise<ControlStateResponse> {
  return requestJson("/api/control/state")
}

export async function getControlOperations(limit = 20): Promise<{
  operations: Array<Record<string, unknown>>
}> {
  return requestJson(`/api/control/operations?limit=${limit}`)
}

export async function planControlOperation(input: {
  capability: string
  action: string
  input?: Record<string, unknown>
  context?: ControlRequestContext
}): Promise<{ plan: ControlPlan }> {
  return requestJson("/api/control/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, context: input.context || { origin: "dashboard" } }),
  })
}

export async function executeControlOperation(input: {
  capability: string
  action: string
  input?: Record<string, unknown>
  plan?: ControlPlan
  approvalRequestId?: string
  context?: ControlRequestContext
}): Promise<{ outcome: ControlOutcome }> {
  return requestJson("/api/control/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, context: input.context || { origin: "dashboard" } }),
  })
}
