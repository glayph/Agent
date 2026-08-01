import { launcherFetch } from "@/api/http"

export interface SkillSupportItem {
  name: string
  path: string
  source: "workspace" | "global" | "builtin" | string
  description: string
  origin_kind: "builtin" | "third_party" | "manual" | string
  registry_name?: string
  registry_url?: string
  installed_version?: string
  installed_at?: number
}

export interface SkillDetailResponse extends SkillSupportItem {
  content: string
}

export interface SkillRegistrySearchResult {
  score: number
  slug: string
  id?: string
  display_name: string
  summary: string
  version: string
  registry_name: string
  url?: string
  installed: boolean
  installed_name?: string
}

interface SkillsResponse {
  skills: SkillSupportItem[]
}

export interface SkillSearchResponse {
  results: SkillRegistrySearchResult[]
  limit: number
  offset: number
  next_offset?: number
  has_more: boolean
}

type SkillActionResponse = Partial<SkillSupportItem> & {
  status?: string
}

export interface InstallSkillRequest {
  slug: string
  id?: string
  url?: string
  registry: string
  version?: string
  force?: boolean
}

export interface InstallSkillResponse {
  status: string
  slug: string
  registry: string
  version: string
  summary?: string
  is_suspicious?: boolean
  skill?: SkillSupportItem
}

export type PluginMarketplaceReadinessStatus =
  | "ready"
  | "metadata_only"
  | "needs_policy"
  | "incomplete"
  | "blocked"

export type PluginMarketplaceIssueSeverity = "error" | "warning" | "info"

export interface PluginMarketplaceIssue {
  severity: PluginMarketplaceIssueSeverity
  code: string
  message: string
  contract?: {
    kind: string
    name: string
  }
  path?: string
  permission?: string
}

export interface PluginMarketplaceContractSummary {
  total: number
  executable: number
  ready: number
  metadataOnly: number
  needsPolicy: number
  blocked: number
  byKind: Record<string, number>
  permissions: string[]
  risk: "low" | "medium" | "high"
}

export interface PluginMarketplaceAuditEventSummary {
  type: "plugin.execute" | "plugin.channel_runtime"
  action?: string
  status?: string
  subject: string
  createdAt: string
  contractName?: string
  kind?: string
  error?: string
}

export interface PluginMarketplaceAuditSummary {
  total: number
  executions: number
  channelRuntimeEvents: number
  succeeded: number
  failed: number
  blocked: number
  lastEventAt?: string
  lastAction?: string
  lastStatus?: string
  recent: PluginMarketplaceAuditEventSummary[]
}

export interface PluginMarketplaceReadinessReport {
  plugin: {
    name: string
    version: string
    description: string
    author?: string
    license?: string
    installedAt: string
    sourceProtocol: string
    path: string
    entrypoint: string
    assetsPath?: string
  }
  status: PluginMarketplaceReadinessStatus
  marketplaceReady: boolean
  score: number
  summary: PluginMarketplaceContractSummary
  audit: PluginMarketplaceAuditSummary
  issues: PluginMarketplaceIssue[]
}

export interface PluginMarketplaceReadinessResponse {
  data: PluginMarketplaceReadinessReport[]
  total: number
  summary: Record<PluginMarketplaceReadinessStatus, number> & {
    contracts: number
    issues: number
    auditEvents: number
  }
  generatedAt: string
  skillsDir: string
  configPath: string
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await launcherFetch(path, options)
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res))
  }
  return res.json() as Promise<T>
}

export async function getSkills(): Promise<SkillsResponse> {
  return request<SkillsResponse>("/api/skills")
}

export async function getSkill(name: string): Promise<SkillDetailResponse> {
  return request<SkillDetailResponse>(`/api/skills/${encodeURIComponent(name)}`)
}

export async function searchSkills(
  query: string,
  limit = 20,
  offset = 0,
): Promise<SkillSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    offset: String(offset),
  })
  return request<SkillSearchResponse>(`/api/skills/search?${params.toString()}`)
}

export async function installSkill(
  input: InstallSkillRequest,
): Promise<InstallSkillResponse> {
  return request<InstallSkillResponse>("/api/skills/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
}

export async function getPluginMarketplaceReadiness(): Promise<PluginMarketplaceReadinessResponse> {
  return request<PluginMarketplaceReadinessResponse>(
    "/api/skills/plugin-marketplace/readiness",
  )
}

export async function importSkill(file: File): Promise<SkillActionResponse> {
  const formData = new FormData()
  formData.set("file", file)

  const res = await launcherFetch("/api/skills/import", {
    method: "POST",
    body: formData,
  })
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res))
  }
  return res.json() as Promise<SkillActionResponse>
}

export async function deleteSkill(name: string): Promise<SkillActionResponse> {
  return request<SkillActionResponse>(
    `/api/skills/${encodeURIComponent(name)}`,
    {
      method: "DELETE",
      headers: { "X-Hiro-Confirm": "delete-skill" },
    },
  )
}

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const raw = await res.text()
    if (raw.trim() === "") {
      return `API error: ${res.status} ${res.statusText}`
    }
    try {
      const body = JSON.parse(raw) as {
        error?: string
        errors?: string[]
      }
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        return body.errors.join("; ")
      }
      if (typeof body.error === "string" && body.error.trim() !== "") {
        return body.error
      }
    } catch {
      return raw.trim()
    }
  } catch {
    // ignore invalid body
  }
  return `API error: ${res.status} ${res.statusText}`
}
