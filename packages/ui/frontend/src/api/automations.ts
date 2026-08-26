import { launcherFetch } from "@/api/http"

export type AutomationStatus = "active" | "paused" | "disabled"
export type AutomationTarget = "internal" | "research" | "facebook" | "youtube"
export type AutomationApprovalMode = "none" | "review" | "publish"
export type AutomationExecutionStatus =
  "pending" | "running" | "completed" | "failed" | "cancelled"

export interface AutomationDefinition {
  id: string
  name: string
  objective: string
  sessionId: string
  steps: string[]
  target: AutomationTarget
  approvalMode: AutomationApprovalMode
  cronExpression?: string
  runAt?: number
  timezone: string
  maxAttempts: number
  status: AutomationStatus
  scheduledTaskId?: string
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  nextRunAt?: number
}

export interface AutomationExecution {
  id: string
  automationId: string
  runId: string
  scheduledTaskId?: string
  status: AutomationExecutionStatus
  trigger: "manual" | "scheduled"
  startedAt?: number
  completedAt?: number
  error?: string
  createdAt: number
  updatedAt: number
}

export interface CreateAutomationPayload {
  name: string
  objective: string
  steps: string[]
  target: AutomationTarget
  approvalMode: AutomationApprovalMode
  cronExpression?: string
  runAt?: string
  timezone: string
  maxAttempts: number
}

export interface UpdateAutomationPayload {
  name?: string
  objective?: string
  steps?: string[]
  target?: AutomationTarget
  approvalMode?: AutomationApprovalMode
  cronExpression?: string | null
  runAt?: string | number | null
  timezone?: string
  maxAttempts?: number
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await launcherFetch(path, options)
  if (!response.ok) {
    let message = `API error: ${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error?.trim()) message = body.error
    } catch {
      // Keep the HTTP status when the server does not return JSON.
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export async function listAutomations(limit = 100) {
  return request<{ automations: AutomationDefinition[] }>(
    `/api/automations?limit=${encodeURIComponent(String(limit))}`,
  )
}

export async function getAutomation(id: string) {
  return request<{ automation: AutomationDefinition }>(
    `/api/automations/${encodeURIComponent(id)}`,
  )
}

export async function listAutomationExecutions(id: string, limit = 50) {
  return request<{ executions: AutomationExecution[] }>(
    `/api/automations/${encodeURIComponent(id)}/executions?limit=${encodeURIComponent(String(limit))}`,
  )
}

export async function createAutomation(payload: CreateAutomationPayload) {
  return request<{ automation: AutomationDefinition }>("/api/automations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

export async function updateAutomation(
  id: string,
  payload: UpdateAutomationPayload,
) {
  return request<{ automation: AutomationDefinition }>(
    `/api/automations/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  )
}

export async function automationAction(
  id: string,
  action: "pause" | "resume" | "cancel",
) {
  return request<{ automation: AutomationDefinition }>(
    `/api/automations/${encodeURIComponent(id)}/${action}`,
    { method: "POST" },
  )
}

export async function runAutomationNow(id: string) {
  return request<{ execution: AutomationExecution }>(
    `/api/automations/${encodeURIComponent(id)}/run-now`,
    { method: "POST" },
  )
}

export type PlatformProvider =
  | "facebook"
  | "youtube"
  | "x"
  | "telegram"
  | "whatsapp"
  | "instagram"
  | "linkedin"
  | "discord"
  | "slack"
  | "webhook"

export type PlatformImplementation = "planned" | "partial" | "ready"
export type ConnectionStatus =
  | "needs_browser"
  | "awaiting_user"
  | "needs_validation"
  | "connected"
  | "restricted"
  | "token_expiring"
  | "revoked"
  | "failed"

export interface PlatformCapability {
  id: string
  label: string
  available: boolean
  requiresApproval: boolean
  notes: string
}

export interface PlatformDescriptor {
  id: PlatformProvider
  label: string
  category: "social" | "messaging" | "developer" | "utility"
  officialUrl: string
  connectionMode: "oauth" | "bot_token" | "api_key" | "browser_bridge"
  implementation: PlatformImplementation
  capabilities: PlatformCapability[]
  requiredScopes: string[]
  setupSteps: string[]
}

export interface PlatformConnection {
  id: string
  provider: PlatformProvider
  accountLabel: string
  externalAccountId?: string
  status: ConnectionStatus
  scopes: string[]
  browserSessionId?: string
  lastValidatedAt?: string
  expiresAt?: string
  createdAt: string
  updatedAt: string
  healthMessage: string
}

export interface BrowserConnectionSession {
  id: string
  provider: PlatformProvider
  status:
    | "created"
    | "browser_opened"
    | "awaiting_user"
    | "completed"
    | "expired"
    | "cancelled"
    | "failed"
  requestedScopes: string[]
  officialUrl: string
  expectedDomain: string
  createdAt: string
  expiresAt: string
  connectionId?: string
  userActionRequired: string
}

export async function listPlatforms() {
  return request<{ platforms: PlatformDescriptor[] }>("/api/platforms")
}

export async function listConnections(limit = 100) {
  return request<{ connections: PlatformConnection[] }>(
    `/api/connections?limit=${encodeURIComponent(String(limit))}`,
  )
}

export async function beginBrowserConnection(
  provider: PlatformProvider,
  scopes?: string[],
) {
  return request<{
    session: BrowserConnectionSession
    browser: {
      action: string
      url: string
      expectedDomain: string
      requiresUserHandoff: boolean
      message: string
    }
  }>("/api/connections/browser/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, scopes }),
  })
}

export async function markBrowserConnectionOpened(sessionId: string) {
  return request<{ session: BrowserConnectionSession }>(
    `/api/connections/browser/${encodeURIComponent(sessionId)}/opened`,
    { method: "POST" },
  )
}

export async function completeBrowserConnection(
  sessionId: string,
  payload: {
    accountLabel: string
    externalAccountId?: string
    scopes?: string[]
    credentialRef?: string
    expiresAt?: string
  },
) {
  return request<{
    session: BrowserConnectionSession
    connection: PlatformConnection
  }>(`/api/connections/browser/${encodeURIComponent(sessionId)}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

export async function validateConnection(id: string) {
  return request<{ connection: PlatformConnection }>(
    `/api/connections/${encodeURIComponent(id)}/validate`,
    { method: "POST" },
  )
}

export async function revokeConnection(id: string) {
  return request<{ connection: PlatformConnection }>(
    `/api/connections/${encodeURIComponent(id)}/revoke`,
    { method: "POST" },
  )
}

export async function storePlatformToken(payload: {
  provider: PlatformProvider
  token: string
  accountLabel: string
  externalAccountId?: string
  scopes?: string[]
  expiresAt?: string
}) {
  return request<{
    session: BrowserConnectionSession
    connection: PlatformConnection
    credentialStored: boolean
  }>("/api/connections/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

export async function startBrowserPlatformConnection(
  provider: PlatformProvider,
  scopes?: string[],
) {
  return beginBrowserConnection(provider, scopes)
}

export async function completeConnectionFromOpaqueToken(
  provider: PlatformProvider,
  accountLabel: string,
  token: string,
  scopes?: string[],
) {
  return storePlatformToken({ provider, accountLabel, token, scopes })
}
