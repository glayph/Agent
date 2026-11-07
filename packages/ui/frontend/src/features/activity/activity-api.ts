import { launcherFetch } from "@/api/http"

export interface RunningGoal {
  id: number
  title: string
  status: string
  progress: number
  run_id: string | null
  started_at: string | null
  last_progress_at: string | null
}

export interface RecentRun {
  run_id: string
  goal_id: number
  status: string
  started_at: string
  finished_at: string | null
  error: string | null
}

export interface AutonomyStatus {
  enabled: boolean
  running?: boolean
  paused: boolean
  in_flight: boolean
  loop_restart_pending?: boolean
  loop_restart_attempt?: number
  loop_restart_count?: number
  proactive_loop?: {
    enabled: boolean
    startup_decision: boolean
    llm_when_idle: boolean
    mode: "event_driven_continuous" | "goal_execution_only" | string
    ambient_in_flight: boolean
    wake_pending: boolean
    last_decision_at: string | null
    observer?: { status: "disabled" | "unavailable" | "observed" | "failed" | string; last_observed_at: string | null }
    quiet_observation_interval_seconds: number
    failure_streak: number
    circuit_open: boolean
    next_decision_in_seconds: number
  }
  max_concurrent_tasks?: number
  running_goals?: RunningGoal[]
  recent_runs?: RecentRun[]
  task_queue?: Array<{ task_id: number; title: string; status: string; due_at: string }>
}


export interface ScheduledTask {
  task_id: number
  title: string
  description?: string | null
  due_at: string
  next_run_at?: string
  interval_seconds?: number | null
  schedule_type?: "once" | "interval" | "cron" | string
  cron_expression?: string | null
  timezone?: string | null
  misfire_policy?: "skip" | "run_once" | string
  last_run_at?: string | null
  last_outcome?: string | null
  missed_runs?: number
  status: string
  last_error?: string | null
  last_result?: string | null
}

export interface BackgroundJobEvent {
  event_id?: number | string
  type?: string
  event_type?: string
  created_at?: string
  timestamp?: string
  payload?: unknown
  [key: string]: unknown
}

export interface BackgroundJobTreeNode {
  task?: BackgroundJob
  children?: BackgroundJobTreeNode[]
  [key: string]: unknown
}

export interface BackgroundJobDetail {
  job: BackgroundJob
  tree: BackgroundJobTreeNode | null
  events: BackgroundJobEvent[]
}

export interface EventTrigger {
  trigger_id: number
  event_name: string
  title: string
  description: string | null
  filter_json: string | null
  acceptance_contract: string | null
  enabled: number | boolean
  created_at: string
}

export interface BackgroundJob {
  id: string
  goal: string
  sessionId: string | null
  status: string
  progress: number | null
  attempt: number
  maxAttempts: number
  createdAt: string
  updatedAt: string
  result: string | null
  error: string | null
  needsReconciliation: boolean
}

export interface LearnedRule {
  category: string
  match: string
  decision: "act" | "ask" | "block"
  note: string
  updatedAt: string
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await launcherFetch(path, { showErrorToast: false, ...init })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error || `API error: ${res.status}`)
  return body
}

export const getAutonomyStatus = () => json<AutonomyStatus>("/api/autonomy/status")

export interface AutonomousActivity {
  fetched_at: string
  provider: {
    state: string
    failure_streak: number
    circuit_open: boolean
    last_failure: { kind: string; message: string; at: string } | null
    last_success_at: string | null
    last_recovered_at: string | null
    next_attempt_at: string | null
  }
  ambient: Array<{ run_id: string; trigger_source: string; status: string; created_at: string; result: string | null; goal_ids: string | null }>
  heartbeat: Array<{ triggered_at: string; probe_ok: number; probe_detail: string | null; queued_tasks: number; blocked_goals: number; retry_wait_goals: number; recovered_tasks: number; stalled_runs: number }>
}

export const getAutonomousActivity = (limit = 12) =>
  json<AutonomousActivity>(`/api/autonomy/activity?limit=${Math.max(1, Math.min(50, Math.trunc(limit)))}`)

export const getLearnedRules = () => json<{ rules: LearnedRule[] }>("/api/permissions/rules")

export const getEventTriggers = (limit = 100) =>
  json<{ triggers: EventTrigger[] }>(`/api/autonomy/triggers?limit=${Math.max(1, Math.min(200, Math.trunc(limit)))}`)

export const createEventTrigger = (input: {
  event_name: string
  title: string
  description?: string
  filter?: Record<string, unknown>
  acceptance?: Record<string, unknown> | null
}) => json<{ trigger: EventTrigger }>("/api/autonomy/triggers", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
})

export const updateEventTrigger = (triggerId: number, input: {
  title?: string
  description?: string | null
  filter?: Record<string, unknown> | null
  enabled?: boolean
  acceptance?: Record<string, unknown> | null
}) => json<{ trigger: EventTrigger }>(`/api/autonomy/triggers/${triggerId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
})

export const disableEventTrigger = (triggerId: number) =>
  json<{ disabled: boolean }>(`/api/autonomy/triggers/${triggerId}/disable`, { method: "POST" })

export const forgetLearnedRule = (category: string, match: string) =>
  json<{ removed: boolean }>("/api/permissions/rules", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, match }),
  })


export const getScheduledTasks = (limit = 100, offset = 0) => {
  const pageLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 100
  const pageOffset = Number.isFinite(offset) ? Math.max(0, Math.min(2_147_483_647, Math.trunc(offset))) : 0
  return json<{ tasks: ScheduledTask[] }>(`/api/autonomy/tasks?limit=${pageLimit}&offset=${pageOffset}`)
}

export const createScheduledTask = (input: {
  title: string
  description?: string
  due_at?: string
  interval_seconds?: number
  acceptance?: Record<string, unknown> | null
}) => json<{ task: ScheduledTask }>("/api/autonomy/tasks", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
})

export const createCronTask = (input: {
  title: string
  description?: string
  cron_expression: string
  timezone: string
  misfire_policy: "skip" | "run_once"
  acceptance?: Record<string, unknown> | null
}) => json<{ task: ScheduledTask }>("/api/autonomy/tasks", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
})

export const updateScheduledTask = (taskId: number, input: {
  title?: string
  description?: string
  cron_expression?: string
  due_at?: string
  interval_seconds?: number
  timezone?: string
  misfire_policy?: "skip" | "run_once"
}) => json<{ task: ScheduledTask }>(`/api/autonomy/tasks/${taskId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
})

export const pauseScheduledTask = (taskId: number) =>
  json<{ task: ScheduledTask }>(`/api/autonomy/tasks/${taskId}/pause`, { method: "POST" })

export const resumeScheduledTask = (taskId: number) =>
  json<{ task: ScheduledTask }>(`/api/autonomy/tasks/${taskId}/resume`, { method: "POST" })

export const cancelScheduledTask = (taskId: number) =>
  json<{ task: ScheduledTask }>(`/api/autonomy/tasks/${taskId}`, { method: "DELETE" })

export const getBackgroundJobs = (limit = 50) =>
  json<{ jobs: BackgroundJob[] }>(`/api/background-jobs?limit=${Math.max(1, Math.min(100, Math.trunc(limit)))}`)

export const getBackgroundJob = (jobId: string) =>
  json<BackgroundJobDetail>(`/api/background-jobs/${encodeURIComponent(jobId)}`)

export const reconcileBackgroundJob = (jobId: string, input: {
  evidence: Record<string, unknown>
  actions?: Array<{ task_id: string; action_key: string; outcome: "completed" | "not_applied"; evidence?: Record<string, unknown>; result?: unknown }>
}) => json<{
  resumedTaskIds: string[]
  tree: BackgroundJobTreeNode | null
  remainingUnsettledActions: Array<{ taskId: string; action_key?: string; [key: string]: unknown }>
}>(`/api/background-jobs/${encodeURIComponent(jobId)}/reconcile`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
})

export const cancelBackgroundJob = (jobId: string) =>
  json<{ accepted: boolean; status?: string; id: string }>(`/api/background-jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" })

export const cancelActiveTask = (runId: string) =>
  json<{ status: string; id: string }>(`/api/tasks/${encodeURIComponent(runId)}`, { method: "DELETE" })
