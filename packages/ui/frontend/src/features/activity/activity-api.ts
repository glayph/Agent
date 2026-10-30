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
  paused: boolean
  in_flight: boolean
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

export const getScreenshot = (signal?: AbortSignal) =>
  json<{ png_base64: string; width: number | null; height: number | null; captured_at: string }>(
    "/api/autonomy/screenshot",
    { cache: "no-store", ...(signal ? { signal } : {}) },
  )

export const getLearnedRules = () => json<{ rules: LearnedRule[] }>("/api/permissions/rules")

export const forgetLearnedRule = (category: string, match: string) =>
  json<{ removed: boolean }>("/api/permissions/rules", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, match }),
  })


export const getScheduledTasks = (limit = 100) =>
  json<{ tasks: ScheduledTask[] }>(`/api/autonomy/tasks?limit=${limit}`)

export const createCronTask = (input: {
  title: string
  description?: string
  cron_expression: string
  timezone: string
  misfire_policy: "skip" | "run_once"
}) => json<{ task: ScheduledTask }>("/api/autonomy/tasks", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
})

export const updateScheduledTask = (taskId: number, input: {
  title?: string
  description?: string
  cron_expression?: string
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
