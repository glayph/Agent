import { launcherFetch } from "./http"

export type ImprovementCycle = {
  id?: string
  cycleType?: string
  startedAt?: string
  completedAt?: string | null
  status?: string
  inputCount?: number
  outputCount?: number
}

export type ImprovementStatus = {
  enabled: boolean
  degraded?: boolean
  degradedReason?: string | null
  reflectionDue?: boolean
  tuningDue?: boolean
  optimizationDue?: boolean
  reflectionsToday?: number
  accumulatedTunings?: number
  circuitBreaker?: {
    tripped?: boolean
    errorRate?: number
    totalCalls?: number
    recentErrors?: string[]
  }
  learning?: {
    totalSuggestions?: number
    appliedCount?: number
    rewards?: number[]
    actions?: Array<Record<string, unknown>>
    outcomes?: Array<Record<string, unknown>>
  }
  behaviorLearning?: {
    enabled?: boolean
    mode?: string
    decisions?: number
    averageReward?: number
    bestActions?: string[]
    policyVersion?: number
    explorationRate?: number
    minSamples?: number
  }
  latestCycles?: {
    reflection?: ImprovementCycle | null
    promptTuning?: ImprovementCycle | null
    optimization?: ImprovementCycle | null
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

export async function getImprovementStatus(): Promise<{
  self_improvement: ImprovementStatus
}> {
  return request("/api/improvement/status")
}
