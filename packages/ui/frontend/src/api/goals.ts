import { launcherFetch } from "@/api/http"

class GoalApiError extends Error {
  public readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "GoalApiError"
    this.status = status
  }
}

export interface GoalRow {
  id: number
  title: string
  description: string | null
  priority: number
  status: "pending" | "active" | "completed" | "blocked" | "cancelled" | string
  status_reason: string | null
  progress: number
  total_steps: number
  completed_steps: number
  context: string | null
  source: string | null
  last_pursued_at: string | null
  created_at: string
  updated_at: string
}

export interface GoalPlanStep {
  id: number
  description: string
  status: "pending" | "in_progress" | "completed" | "failed"
  depends_on: number[]
}

export interface GoalPlan {
  id: string
  title: string
  status: "active" | "completed" | "cancelled"
  steps: GoalPlanStep[]
  created_at: string
  updated_at: string
}

export interface PursueGoalSnapshot {
  active: GoalRow | null
  activePlan: GoalPlan | null
  goals: GoalRow[]
  summary: {
    hasActiveGoal: boolean
    activeGoalId: number | null
    activePlanId: string | null
    progress: number
    completedSteps: number
    totalSteps: number
    nextStep: string | null
  }
}

export interface CreatePursueGoalInput {
  objective: string
  description?: string
  steps?: string[]
  replaceExisting?: boolean
}

export interface UpdatePursueGoalInput {
  status?: "pending" | "active" | "completed" | "blocked" | "cancelled"
  statusReason?: string
  completedSteps?: number
  totalSteps?: number
  progress?: number
}

function createEmptyPursueGoalSnapshot(): PursueGoalSnapshot {
  return {
    active: null,
    activePlan: null,
    goals: [],
    summary: {
      hasActiveGoal: false,
      activeGoalId: null,
      activePlanId: null,
      progress: 0,
      completedSteps: 0,
      totalSteps: 0,
      nextStep: null,
    },
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await launcherFetch(path, options)
  if (!res.ok) {
    let message = `API error: ${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as {
        error?: string
        detail?: string
      }
      message = body.error || body.detail || message
    } catch {
      // Keep default fallback.
    }
    throw new GoalApiError(message, res.status)
  }
  return res.json() as Promise<T>
}

export async function getPursueGoal(): Promise<PursueGoalSnapshot> {
  try {
    return await request<PursueGoalSnapshot>("/api/goals")
  } catch (error) {
    if (error instanceof GoalApiError && error.status === 404) {
      return createEmptyPursueGoalSnapshot()
    }
    throw error
  }
}

export function createPursueGoal(
  input: CreatePursueGoalInput,
): Promise<PursueGoalSnapshot> {
  return request<PursueGoalSnapshot>("/api/goals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      objective: input.objective,
      description: input.description,
      steps: input.steps,
      replaceExisting: input.replaceExisting,
    }),
  })
}

export function updatePursueGoal(
  goalId: number,
  input: UpdatePursueGoalInput,
): Promise<PursueGoalSnapshot> {
  return request<PursueGoalSnapshot>(`/api/goals/${goalId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
}
