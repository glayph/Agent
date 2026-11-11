import { IconActivity, IconAlertTriangle, IconBolt, IconBrain, IconCircleCheck, IconClock, IconLoader2, IconPlayerStop, IconRefresh, IconScreenShare, IconTrash } from "@tabler/icons-react"
import { useAtomValue } from "jotai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"

import { PageHeader } from "@/app/layout/page-header"
import { hydrateMonitorHistory, monitorAtom, type MonitorNode } from "@/features/monitor/store"
import { chatAtom } from "@/store/chat"
import { cn } from "@/lib/utils"
import { fetchMonitorHistory, type MonitorHistoryCursor, type ServerMonitorSnapshot } from "@/features/monitor/history-api"

import {
  cancelBackgroundJob,
  cancelActiveTask,
  cancelScheduledTask,
  createCronTask,
  createScheduledTask,
  createEventTrigger,
  getEventTriggers,
  updateEventTrigger,
  getBackgroundJob,
  reconcileBackgroundJob,
  forgetLearnedRule,
  getAutonomyStatus,
  getAutonomousActivity,
  getBackgroundJobs,
  getLearnedRules,
  getScheduledTasks,
  pauseScheduledTask,
  resumeScheduledTask,
  updateScheduledTask,
  type AutonomyStatus,
  type AutonomousActivity,
  type BackgroundJob,
  type BackgroundJobDetail,
  type EventTrigger,
  type LearnedRule,
  type ScheduledTask,
} from "./activity-api"

const STATUS_POLL_MS = 5000
const TASK_POLL_MS = 30000

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} data-page-section="true" className="border-border/50 bg-card/65 rounded-xl border p-4 shadow-sm">
      <h2 className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-[0.14em] uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

function MetricTile({
  label,
  value,
  detail,
  icon: Icon,
  tone = "text-foreground",
}: {
  label: string
  value: string
  detail: string
  icon: typeof IconActivity
  tone?: string
}) {
  return (
    <div className="border-border/60 bg-card/70 rounded-xl border p-3 shadow-sm">
      <div className="text-muted-foreground flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] uppercase">
        <Icon className={cn("size-4", tone)} aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className={cn("mt-2 text-xl font-semibold tracking-tight", tone)}>{value}</div>
      <div className="text-muted-foreground mt-1 truncate text-xs">{detail}</div>
    </div>
  )
}

const DECISION_STYLE: Record<LearnedRule["decision"], string> = {
  act: "bg-emerald-500/15 text-emerald-600",
  ask: "bg-amber-500/15 text-amber-600",
  block: "bg-red-500/15 text-red-600",
}

function parseOptionalJsonObject(value: string, fieldName: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object.`)
  }
  return parsed as Record<string, unknown>
}

function scheduleTypeOf(task: ScheduledTask): "once" | "interval" | "cron" {
  if (task.schedule_type === "cron" || task.cron_expression) return "cron"
  if (task.schedule_type === "interval" || task.interval_seconds) return "interval"
  return "once"
}

/** Operational activity console for goals, jobs, schedules, triggers, screen sharing, and learned rules. */
export function ActivityView() {
  const { t, i18n } = useTranslation()
  const localStatus = (value?: unknown) => {
    if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\u0000-\u001f]/.test(value))
      return t("pages.activity.statuses.unknown", { defaultValue: "Unknown" })
    const normalized = value.trim().replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_")
    const key = normalized.toLowerCase()
    const fallback = normalized.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
    return t(`pages.activity.statuses.${key}`, { defaultValue: fallback })
  }
  const safeJsonPreview = (value: unknown, maxChars = 12_000) => {
    let serialized = ""
    try {
      serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value ?? "")
    } catch {
      serialized = "[Unable to render this activity payload]"
    }
    return serialized.length > maxChars ? `${serialized.slice(0, maxChars)}\n…[preview truncated]` : serialized
  }
  const [status, setStatus] = useState<AutonomyStatus | null>(null)
  const [statusError, setStatusError] = useState<string>()
  const [autonomousActivity, setAutonomousActivity] = useState<AutonomousActivity | null>(null)
  const [autonomousActivityError, setAutonomousActivityError] = useState<string>()
  const [goalBusy, setGoalBusy] = useState<string>()
  const [rules, setRules] = useState<LearnedRule[]>([])
  const [rulesLoading, setRulesLoading] = useState(true)
  const [rulesError, setRulesError] = useState<string>()
  const [ruleBusy, setRuleBusy] = useState<string>()
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null)
  const [screenShareStarting, setScreenShareStarting] = useState(false)
  const [screenShareError, setScreenShareError] = useState<string>()
  const screenVideoRef = useRef<HTMLVideoElement>(null)
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([])
  const [scheduleLoaded, setScheduleLoaded] = useState(false)
  const [scheduleOffset, setScheduleOffset] = useState(0)
  const scheduleOffsetRef = useRef(0)
  const [scheduleHasMore, setScheduleHasMore] = useState(false)
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([])
  const [backgroundJobsError, setBackgroundJobsError] = useState<string>()
  const [backgroundJobBusy, setBackgroundJobBusy] = useState<string>()
  const [selectedJobId, setSelectedJobId] = useState<string>()
  const [selectedJobDetail, setSelectedJobDetail] = useState<BackgroundJobDetail>()
  const [jobDetailBusy, setJobDetailBusy] = useState(false)
  const [jobDetailError, setJobDetailError] = useState<string>()
  const [reconcileEvidence, setReconcileEvidence] = useState("{}")
  const [reconcileActions, setReconcileActions] = useState("[]")
  const [reconcileBusy, setReconcileBusy] = useState(false)
  const [reconcileResult, setReconcileResult] = useState<Awaited<ReturnType<typeof reconcileBackgroundJob>>>()
  const [scheduleError, setScheduleError] = useState<string>()
  const [scheduleBusy, setScheduleBusy] = useState(false)
  const [scheduleType, setScheduleType] = useState<"cron" | "once" | "interval">("cron")
  const [onceAt, setOnceAt] = useState(() => new Date(Date.now() + 60 * 60 * 1000 - new Date().getTimezoneOffset() * 60 * 1000).toISOString().slice(0, 16))
  const [intervalSeconds, setIntervalSeconds] = useState("3600")
  const [scheduleAcceptance, setScheduleAcceptance] = useState("")
  const [triggers, setTriggers] = useState<EventTrigger[]>([])
  const [triggerError, setTriggerError] = useState<string>()
  const [triggerBusy, setTriggerBusy] = useState(false)
  const [triggerName, setTriggerName] = useState("")
  const [triggerTitle, setTriggerTitle] = useState("")
  const [triggerDescription, setTriggerDescription] = useState("")
  const [triggerFilter, setTriggerFilter] = useState("{}")
  const [triggerAcceptance, setTriggerAcceptance] = useState("")
  const [editingTriggerId, setEditingTriggerId] = useState<number | null>(null)
  const [editTriggerTitle, setEditTriggerTitle] = useState("")
  const [editTriggerDescription, setEditTriggerDescription] = useState("")
  const [editTriggerFilter, setEditTriggerFilter] = useState("{}")
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [monitorHistoryCursor, setMonitorHistoryCursor] = useState<MonitorHistoryCursor | null>(null)
  const [monitorHistoryError, setMonitorHistoryError] = useState<string>()
  const [monitorHistoryLoading, setMonitorHistoryLoading] = useState(false)
  const [activityHistoryNodes, setActivityHistoryNodes] = useState<ServerMonitorSnapshot["nodes"]>([])
  const [toolCallLimit, setToolCallLimit] = useState(20)
  const [cronTitle, setCronTitle] = useState("")
  const [cronDescription, setCronDescription] = useState("")
  const [cronExpression, setCronExpression] = useState("0 9 * * 1-5")
  const [cronTimezone, setCronTimezone] = useState("Asia/Dhaka")
  const [cronMisfirePolicy, setCronMisfirePolicy] = useState<"skip" | "run_once">("skip")
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null)
  const [editTitle, setEditTitle] = useState("")
  const [editDescription, setEditDescription] = useState("")
  const [editDueAt, setEditDueAt] = useState("")
  const [editIntervalSeconds, setEditIntervalSeconds] = useState("3600")
  const [editExpression, setEditExpression] = useState("")
  const [editTimezone, setEditTimezone] = useState("Asia/Dhaka")
  const [editMisfirePolicy, setEditMisfirePolicy] = useState<"skip" | "run_once">("skip")
  const connectionState = useAtomValue(chatAtom).connectionState
  const monitorNodes = useAtomValue(monitorAtom).nodes as Record<string, MonitorNode>

  useEffect(() => {
    let stopped = false
    let inFlight = false
    const load = async () => {
      if (stopped || document.visibilityState !== "visible" || inFlight) return
      inFlight = true
      try {
        const [next, activity] = await Promise.all([getAutonomyStatus(), getAutonomousActivity()])
        if (!stopped) { setStatus(next); setStatusError(undefined); setAutonomousActivity(activity); setAutonomousActivityError(undefined) }
      } catch (error) {
        if (!stopped) {
          const message = error instanceof Error ? error.message : String(error)
          setStatusError(message)
          setAutonomousActivityError(message)
        }
      } finally {
        inFlight = false
      }
    }
    const onVisibility = () => { if (document.visibilityState === "visible") void load() }
    void load()
    const timer = window.setInterval(() => void load(), STATUS_POLL_MS)
    document.addEventListener("visibilitychange", onVisibility)
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility) }
  }, [])

  const loadBackgroundJobs = useCallback(async () => {
    try {
      const next = await getBackgroundJobs(50)
      setBackgroundJobs(next.jobs)
      setBackgroundJobsError(undefined)
    } catch (error) {
      setBackgroundJobsError(error instanceof Error ? error.message : String(error))
    }
  }, [])
  useEffect(() => {
    let stopped = false
    let inFlight = false
    const load = async () => {
      if (stopped || inFlight || document.visibilityState !== "visible") return
      inFlight = true
      try { await loadBackgroundJobs() } finally { inFlight = false }
    }
    const onVisibility = () => { if (document.visibilityState === "visible") void load() }
    void load()
    const timer = window.setInterval(() => void load(), STATUS_POLL_MS)
    document.addEventListener("visibilitychange", onVisibility)
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility) }
  }, [loadBackgroundJobs])

  const handleCancelGoal = async (runId: string) => {
    setGoalBusy(runId)
    setStatusError(undefined)
    try {
      await cancelActiveTask(runId)
      const next = await getAutonomyStatus()
      setStatus(next)
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error))
    } finally {
      setGoalBusy(undefined)
    }
  }

  const handleCancelBackgroundJob = async (jobId: string) => {
    setBackgroundJobBusy(jobId)
    setBackgroundJobsError(undefined)
    try {
      await cancelBackgroundJob(jobId)
      await loadBackgroundJobs()
    } catch (error) {
      setBackgroundJobsError(error instanceof Error ? error.message : String(error))
    } finally {
      setBackgroundJobBusy(undefined)
    }
  }

  const loadScheduledTasks = useCallback(async (loadMore = false) => {
    const offset = loadMore ? scheduleOffsetRef.current : 0
    try {
      const next = await getScheduledTasks(100, offset)
      setScheduledTasks((current) => {
        if (loadMore) {
          const known = new Set(current.map((task) => task.task_id))
          return [...current, ...next.tasks.filter((task) => !known.has(task.task_id))]
        }
        const refreshedIds = new Set(next.tasks.map((task) => task.task_id))
        return [...next.tasks, ...current.filter((task) => !refreshedIds.has(task.task_id))]
      })
      const nextOffset = loadMore ? offset + next.tasks.length : Math.max(scheduleOffsetRef.current, next.tasks.length)
      scheduleOffsetRef.current = nextOffset
      setScheduleOffset(nextOffset)
      setScheduleHasMore(next.tasks.length === 100)
      setScheduleError(undefined)
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error))
    } finally {
      setScheduleLoaded(true)
    }
  }, [])
  useEffect(() => {
    let inFlight = false
    let stopped = false
    const load = async () => {
      if (stopped || inFlight || document.visibilityState !== "visible") return
      inFlight = true
      try { await loadScheduledTasks() } finally { inFlight = false }
    }
    const onVisibility = () => { if (document.visibilityState === "visible") void load() }
    void load()
    const timer = window.setInterval(() => void load(), TASK_POLL_MS)
    document.addEventListener("visibilitychange", onVisibility)
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility) }
  }, [loadScheduledTasks])

  const handleCreateCron = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setScheduleBusy(true)
    setScheduleError(undefined)
    try {
      const acceptance = parseOptionalJsonObject(scheduleAcceptance, "Acceptance contract")
      if (scheduleType === "cron") {
        await createCronTask({
          title: cronTitle,
          description: cronDescription,
          cron_expression: cronExpression,
          timezone: cronTimezone,
          misfire_policy: cronMisfirePolicy,
          ...(acceptance ? { acceptance } : {}),
        })
      } else if (scheduleType === "once") {
        if (!onceAt) throw new Error("Choose a date and time for the one-time task.")
        await createScheduledTask({
          title: cronTitle,
          description: cronDescription,
          due_at: new Date(onceAt).toISOString(),
          ...(acceptance ? { acceptance } : {}),
        })
      } else {
        const seconds = Number(intervalSeconds)
        if (!Number.isInteger(seconds) || seconds < 60 || seconds > 31536000) throw new Error("Interval must be between 60 and 31536000 seconds.")
        await createScheduledTask({
          title: cronTitle,
          description: cronDescription,
          interval_seconds: seconds,
          ...(acceptance ? { acceptance } : {}),
        })
      }
      setCronTitle("")
      setCronDescription("")
      setScheduleAcceptance("")
      await loadScheduledTasks()
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error))
    } finally {
      setScheduleBusy(false)
    }
  }

  const runScheduleAction = async (action: () => Promise<unknown>) => {
    setScheduleBusy(true)
    setScheduleError(undefined)
    try {
      await action()
      await loadScheduledTasks()
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error))
    } finally {
      setScheduleBusy(false)
    }
  }

  const startEditingTask = (task: ScheduledTask) => {
    setEditingTaskId(task.task_id)
    setEditTitle(task.title)
    setEditDescription(task.description ?? "")
    const date = new Date(task.due_at)
    setEditDueAt(Number.isNaN(date.getTime()) ? "" : new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16))
    setEditIntervalSeconds(String(task.interval_seconds ?? 3600))
    setEditExpression(task.cron_expression ?? "")
    setEditTimezone(task.timezone ?? "Asia/Dhaka")
    setEditMisfirePolicy(task.misfire_policy === "run_once" ? "run_once" : "skip")
  }

  const saveTaskEdit = async (task: ScheduledTask) => {
    await runScheduleAction(async () => {
      const input: Parameters<typeof updateScheduledTask>[1] = {
        title: editTitle.trim(),
        description: editDescription,
      }
      if (!input.title) throw new Error("Task title is required.")
      if (scheduleTypeOf(task) === "cron") {
        input.cron_expression = editExpression
        input.timezone = editTimezone
        input.misfire_policy = editMisfirePolicy
      } else if (scheduleTypeOf(task) === "interval") {
        const seconds = Number(editIntervalSeconds)
        if (!Number.isInteger(seconds) || seconds < 60 || seconds > 31_536_000) throw new Error("Interval must be between 60 and 31536000 seconds.")
        input.interval_seconds = seconds
        if (editDueAt) input.due_at = new Date(editDueAt).toISOString()
      } else {
        if (!editDueAt) throw new Error("Choose a date and time for the one-time task.")
        input.due_at = new Date(editDueAt).toISOString()
      }
      await updateScheduledTask(task.task_id, input)
      setEditingTaskId(null)
    })
  }

  const loadRules = useCallback(async () => {
    setRulesLoading(true)
    try {
      setRules((await getLearnedRules()).rules)
      setRulesError(undefined)
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : String(error))
    } finally {
      setRulesLoading(false)
    }
  }, [])
  const loadTriggers = useCallback(async () => {
    try {
      setTriggers((await getEventTriggers()).triggers)
      setTriggerError(undefined)
    } catch (error) {
      setTriggerError(error instanceof Error ? error.message : String(error))
    }
  }, [])
  useEffect(() => {
    let stopped = false
    let inFlight = false
    const load = async () => {
      if (stopped || inFlight || document.visibilityState !== "visible") return
      inFlight = true
      try { await Promise.all([loadRules(), loadTriggers()]) } finally { inFlight = false }
    }
    const onVisibility = () => { if (document.visibilityState === "visible") void load() }
    void load()
    const timer = window.setInterval(() => void load(), TASK_POLL_MS)
    document.addEventListener("visibilitychange", onVisibility)
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility) }
  }, [loadRules, loadTriggers])

  const loadMonitorHistory = useCallback(async (before?: MonitorHistoryCursor) => {
    setMonitorHistoryLoading(true)
    setMonitorHistoryError(undefined)
    try {
      const snapshot = await fetchMonitorHistory(before, false)
      hydrateMonitorHistory(snapshot)
      setActivityHistoryNodes((current) => {
        const merged = new Map((before ? current : []).map((node) => [node.id, node]))
        for (const node of snapshot.nodes) merged.set(node.id, node)
        return [...merged.values()]
      })
      setMonitorHistoryCursor(snapshot.next_before)
    } catch (error) {
      setMonitorHistoryError(error instanceof Error ? error.message : String(error))
    } finally {
      setMonitorHistoryLoading(false)
    }
  }, [])

  useEffect(() => { void loadMonitorHistory() }, [loadMonitorHistory])

  const startScreenShare = async () => {
    if (screenShareStarting || screenStream) return
    setScreenShareStarting(true)
    setScreenShareError(undefined)
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setScreenShareStarting(false)
      setScreenShareError("This browser or context does not support live screen sharing. Open the dashboard in a secure, supported browser.")
      return
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false,
      })
      const [track] = stream.getVideoTracks()
      if (track) track.addEventListener("ended", () => setScreenStream((current) => current === stream ? null : current), { once: true })
      setScreenStream(stream)
    } catch (error) {
      setScreenShareError(error instanceof Error ? error.message : String(error))
    } finally {
      setScreenShareStarting(false)
    }
  }

  const stopScreenShare = () => {
    screenStream?.getTracks().forEach((track) => track.stop())
    setScreenStream(null)
  }

  useEffect(() => {
    const video = screenVideoRef.current
    if (!video) return
    video.srcObject = screenStream
    if (screenStream) void video.play().catch(() => setScreenShareError("The live stream could not start playback in this browser."))
    return () => { video.srcObject = null }
  }, [screenStream])

  useEffect(() => () => { screenStream?.getTracks().forEach((track) => track.stop()) }, [screenStream])

  const loadBackgroundJobDetail = async (jobId: string) => {
    if (selectedJobId === jobId) {
      setSelectedJobId(undefined)
      setSelectedJobDetail(undefined)
      setJobDetailError(undefined)
      return
    }
    setSelectedJobId(jobId)
    setSelectedJobDetail(undefined)
    setReconcileResult(undefined)
    setJobDetailBusy(true)
    setJobDetailError(undefined)
    try {
      setSelectedJobDetail(await getBackgroundJob(jobId))
    } catch (error) {
      setJobDetailError(error instanceof Error ? error.message : String(error))
    } finally {
      setJobDetailBusy(false)
    }
  }

  const handleReconcileBackgroundJob = async (jobId: string) => {
    setReconcileBusy(true)
    setJobDetailError(undefined)
    try {
      const evidence = JSON.parse(reconcileEvidence) as unknown
      const actions = JSON.parse(reconcileActions) as unknown
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || Object.keys(evidence).length === 0) {
        throw new Error("Evidence must be a non-empty JSON object describing what you independently verified.")
      }
      if (!Array.isArray(actions)) throw new Error("Actions must be a JSON array.")
      const result = await reconcileBackgroundJob(jobId, { evidence: evidence as Record<string, unknown>, actions: actions as never })
      setReconcileResult(result)
      await loadBackgroundJobs()
      setSelectedJobDetail(await getBackgroundJob(jobId))
    } catch (error) {
      setJobDetailError(error instanceof Error ? error.message : String(error))
    } finally {
      setReconcileBusy(false)
    }
  }

  const handleDeleteRule = async (rule: LearnedRule) => {
    const key = `${rule.category}\u0000${rule.match}`
    setRuleBusy(key)
    setRulesError(undefined)
    try {
      await forgetLearnedRule(rule.category, rule.match)
      await loadRules()
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : String(error))
    } finally {
      setRuleBusy(undefined)
    }
  }

  const handleCreateTrigger = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setTriggerBusy(true)
    setTriggerError(undefined)
    try {
      const filter = JSON.parse(triggerFilter) as unknown
      const acceptance = parseOptionalJsonObject(triggerAcceptance, "Acceptance contract")
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("Filter must be a JSON object.")
      await createEventTrigger({
        event_name: triggerName.trim(),
        title: triggerTitle.trim(),
        description: triggerDescription,
        filter: filter as Record<string, unknown>,
        ...(acceptance ? { acceptance } : {}),
      })
      setTriggerName("")
      setTriggerTitle("")
      setTriggerDescription("")
      setTriggerFilter("{}")
      setTriggerAcceptance("")
      await loadTriggers()
    } catch (error) {
      setTriggerError(error instanceof Error ? error.message : String(error))
    } finally {
      setTriggerBusy(false)
    }
  }

  const handleToggleTrigger = async (trigger: EventTrigger) => {
    setTriggerBusy(true)
    setTriggerError(undefined)
    try {
      await updateEventTrigger(trigger.trigger_id, { enabled: !(trigger.enabled === true || trigger.enabled === 1) })
      await loadTriggers()
    } catch (error) {
      setTriggerError(error instanceof Error ? error.message : String(error))
    } finally {
      setTriggerBusy(false)
    }
  }

  const startEditingTrigger = (trigger: EventTrigger) => {
    setEditingTriggerId(trigger.trigger_id)
    setEditTriggerTitle(trigger.title)
    setEditTriggerDescription(trigger.description ?? "")
    setEditTriggerFilter(trigger.filter_json || "{}")
  }

  const saveTriggerEdit = async (triggerId: number) => {
    setTriggerBusy(true)
    setTriggerError(undefined)
    try {
      const filter = JSON.parse(editTriggerFilter) as unknown
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("Filter must be a JSON object.")
      await updateEventTrigger(triggerId, {
        title: editTriggerTitle.trim(),
        description: editTriggerDescription,
        filter: filter as Record<string, unknown>,
      })
      setEditingTriggerId(null)
      await loadTriggers()
    } catch (error) {
      setTriggerError(error instanceof Error ? error.message : String(error))
    } finally {
      setTriggerBusy(false)
    }
  }

  const refreshAll = async () => {
    setRefreshBusy(true)
    const [statusResult, activityResult] = await Promise.allSettled([
      getAutonomyStatus(),
      getAutonomousActivity(),
      loadBackgroundJobs(),
      loadScheduledTasks(),
      loadRules(),
      loadTriggers(),
      loadMonitorHistory(),
    ])
    if (statusResult.status === "fulfilled") {
      setStatus(statusResult.value)
      setStatusError(undefined)
    } else {
      setStatusError(statusResult.reason instanceof Error ? statusResult.reason.message : String(statusResult.reason))
    }
    if (activityResult.status === "fulfilled") {
      setAutonomousActivity(activityResult.value)
      setAutonomousActivityError(undefined)
    } else {
      setAutonomousActivityError(activityResult.reason instanceof Error ? activityResult.reason.message : String(activityResult.reason))
    }
    setRefreshBusy(false)
  }

  const toolCalls = useMemo(() => {
    const merged = new Map<string, ServerMonitorSnapshot["nodes"][number] | MonitorNode>()
    for (const node of activityHistoryNodes) merged.set(node.id, node)
    // The WebSocket-backed Monitor store wins for nodes that changed after the last history request.
    for (const node of Object.values(monitorNodes)) merged.set(node.id, node)
    return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, toolCallLimit)
  }, [activityHistoryNodes, monitorNodes, toolCallLimit])
  const running = status?.running_goals ?? []
  const idleLoop = status?.proactive_loop
  const idleModeKey = !status
    ? "idleLoading"
    : !status.running
      ? "idleStopped"
      : status.paused
        ? "idlePaused"
        : status.loop_restart_pending
          ? "idleRecovering"
          : !idleLoop?.enabled || !idleLoop.llm_when_idle
            ? "idleGoalOnly"
            : idleLoop.circuit_open
              ? "idleBackingOff"
              : idleLoop.ambient_in_flight
                ? "idleDeciding"
                : idleLoop.wake_pending
                  ? "idleWaking"
                  : "idleActive"
  const idleModeLabel = t(`pages.activity.${idleModeKey}`, { defaultValue: "Always-active Idle Mode" })
  const idleModeTone = ["idleActive", "idleDeciding"].includes(idleModeKey)
    ? "bg-emerald-500"
    : ["idleBackingOff", "idleRecovering"].includes(idleModeKey)
      ? "bg-amber-500"
      : "bg-muted-foreground"
  const systemOnline = Boolean(status?.running && !status.paused)
  const providerLabel = localStatus(autonomousActivity?.provider.state ?? (status ? "ready" : "loading"))
  const latestRun = status?.recent_runs?.[0]
  const lastDecision = idleLoop?.last_decision_at
    ? new Date(idleLoop.last_decision_at).toLocaleTimeString(i18n.resolvedLanguage)
    : "Not yet"
  const lastRefresh = autonomousActivity?.fetched_at
    ? new Date(autonomousActivity.fetched_at).toLocaleTimeString(i18n.resolvedLanguage)
    : "Waiting for data"

  return (
    <div className="flex h-full min-h-0 flex-col" data-miki-page="activity">
      <PageHeader title={t("pages.activity.title", { defaultValue: "Activity" })} titleLevel={1} />
      <div className="mx-auto flex min-h-0 min-w-0 w-full max-w-screen-2xl flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-3 sm:p-5 lg:p-6" data-miki-page-body="true">
      <section className="border-border/60 from-primary/[0.12] via-card/80 to-card/50 relative overflow-hidden rounded-2xl border bg-gradient-to-br p-5 shadow-sm">
        <div className="bg-primary/20 absolute -top-16 -right-12 size-40 rounded-full blur-3xl" aria-hidden="true" />
        <div className="relative flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-[0.16em] uppercase">
              <IconActivity className="text-primary size-4" aria-hidden="true" />
              Mission control
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">Miki is {systemOnline ? "online" : "not active"}</h2>
            <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
              {status?.paused
                ? "Autonomous work is paused. Resume it to let Miki continue making progress."
                : running.length > 0
                  ? `${running.length} goal${running.length === 1 ? "" : "s"} currently in progress.`
                  : "No active goals right now. Miki is monitoring events and waiting for the next useful decision."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium", systemOnline ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600" : "border-amber-500/30 bg-amber-500/10 text-amber-600")}>
              <span className={cn("size-2 rounded-full", systemOnline ? "bg-emerald-500" : "bg-amber-500")} aria-hidden="true" />
              {status?.paused ? "Paused" : systemOnline ? "Live" : "Stopped"}
            </span>
            <button type="button" onClick={() => void refreshAll()} disabled={refreshBusy} className="border-border bg-background/70 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs shadow-sm transition-colors hover:bg-background disabled:opacity-50">
              <IconRefresh className={cn("size-3.5", refreshBusy && "animate-spin")} />
              {refreshBusy ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
        <div className="relative mt-5 grid grid-cols-2 gap-2 border-t border-border/50 pt-4 text-xs sm:grid-cols-4">
          <div><span className="text-muted-foreground block">Idle loop</span><strong className="mt-1 block">{idleLoop?.llm_when_idle ? "Enabled" : "Goal-only"}</strong></div>
          <div><span className="text-muted-foreground block">Provider</span><strong className="mt-1 block capitalize">{providerLabel}</strong></div>
          <div><span className="text-muted-foreground block">Last decision</span><strong className="mt-1 block">{lastDecision}</strong></div>
          <div><span className="text-muted-foreground block">Updated</span><strong className="mt-1 block">{lastRefresh}</strong></div>
        </div>
      </section>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile label="Active goals" value={String(running.length)} detail={status ? `${status.max_concurrent_tasks ?? 1} concurrent slots` : "Loading status"} icon={running.length > 0 ? IconBolt : IconCircleCheck} tone={running.length > 0 ? "text-blue-600" : "text-emerald-600"} />
        <MetricTile label="Autonomy" value={status?.paused ? "Paused" : status?.running ? "Running" : "Offline"} detail={idleModeLabel} icon={IconBrain} tone={status?.paused ? "text-amber-600" : "text-primary"} />
        <MetricTile label="Provider" value={autonomousActivity?.provider.failure_streak ? `${autonomousActivity.provider.failure_streak} failures` : "Healthy"} detail={providerLabel} icon={autonomousActivity?.provider.failure_streak ? IconAlertTriangle : IconCircleCheck} tone={autonomousActivity?.provider.failure_streak ? "text-amber-600" : "text-emerald-600"} />
        <MetricTile label="Last run" value={latestRun ? localStatus(latestRun.status) : "None yet"} detail={latestRun ? new Date(latestRun.started_at).toLocaleTimeString(i18n.resolvedLanguage) : "Waiting for work"} icon={IconClock} tone="text-muted-foreground" />
      </div>
      {statusError && <p role="alert" className="text-destructive break-words text-sm">{statusError}</p>}

      <Card title={t("pages.activity.idleMode", { defaultValue: "Always-active Idle Mode" })}>
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true" className={cn("size-2 rounded-full", idleModeTone)} />
          <span className="text-sm font-semibold">{idleModeLabel}</span>
          {idleLoop?.ambient_in_flight && <IconLoader2 className="text-muted-foreground size-3.5 animate-spin" aria-label={t("pages.activity.idleDeciding", { defaultValue: "Observing and deciding" })} />}
          {status?.loop_restart_pending && <span className="text-muted-foreground text-xs">{t("pages.activity.restartAttempt", { count: status.loop_restart_attempt ?? 0, defaultValue: "Restart attempt {{count}}" })}</span>}
        </div>
        {idleLoop && (
          <div className="text-muted-foreground mt-2 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
            <span>{t("pages.activity.observer", { defaultValue: "Computer observer" })}: {localStatus(idleLoop.observer?.status)}</span>
            <span>{t("pages.activity.quietInterval", { defaultValue: "Quiet-environment interval" })}: {idleLoop.quiet_observation_interval_seconds}s</span>
            <span>{t("pages.activity.nextDecision", { defaultValue: "Next decision" })}: {idleLoop.ambient_in_flight ? t("pages.activity.inProgress", { defaultValue: "In progress" }) : `${idleLoop.next_decision_in_seconds}s`}</span>
            <span>{t("pages.activity.providerFailures", { defaultValue: "Consecutive provider failures" })}: {idleLoop.failure_streak}</span>
            <span>{t("pages.activity.lastObservation", { defaultValue: "Last observation" })}: {idleLoop.observer?.last_observed_at ? new Date(idleLoop.observer.last_observed_at).toLocaleTimeString(i18n.resolvedLanguage) : t("pages.activity.never", { defaultValue: "Not yet" })}</span>
            <span>{t("pages.activity.lastDecision", { defaultValue: "Last decision" })}: {idleLoop.last_decision_at ? new Date(idleLoop.last_decision_at).toLocaleTimeString(i18n.resolvedLanguage) : t("pages.activity.never", { defaultValue: "Not yet" })}</span>
          </div>
        )}
        <p className="text-muted-foreground mt-2 text-xs">{t("pages.activity.idleModeInfo", { defaultValue: "Meaningful events and completed goals wake Miki immediately. The quiet interval is used only when the environment has no new event." })}</p>
      </Card>

      <Card title="Autonomous provider activity">
        {autonomousActivityError ? (
          <p role="alert" className="text-destructive break-words text-sm">Autonomous activity is unavailable: {autonomousActivityError}</p>
        ) : !autonomousActivity ? (
          <p className="text-muted-foreground text-sm">Loading autonomous activity…</p>
        ) : (
          <>
            <div className="text-muted-foreground grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
              <span>Provider state: <strong className="text-foreground">{providerLabel}</strong></span>
              <span>Failure streak: {autonomousActivity.provider.failure_streak}</span>
              <span>Next attempt: {autonomousActivity.provider.next_attempt_at ? new Date(autonomousActivity.provider.next_attempt_at).toLocaleString(i18n.resolvedLanguage) : "Not scheduled"}</span>
              <span>Last success: {autonomousActivity.provider.last_success_at ? new Date(autonomousActivity.provider.last_success_at).toLocaleString(i18n.resolvedLanguage) : "Not yet"}</span>
            </div>
            {autonomousActivity.provider.last_failure && <p className="text-muted-foreground mt-2 break-words whitespace-pre-wrap text-xs">Last failure ({localStatus(autonomousActivity.provider.last_failure.kind)}): {autonomousActivity.provider.last_failure.message}</p>}
            {autonomousActivity.ambient.length === 0 ? (
              <p className="text-muted-foreground mt-3 text-sm">No ambient autonomous runs have been recorded yet.</p>
            ) : (
              <ul className="text-muted-foreground mt-3 flex flex-col gap-1 border-t pt-2 text-xs">
                {autonomousActivity.ambient.slice(0, 6).map((run) => <li key={run.run_id} className="break-words">{new Date(run.created_at).toLocaleString(i18n.resolvedLanguage)} · {localStatus(run.trigger_source)} · {localStatus(run.status)}{typeof run.result === "string" && run.result.trim() ? ` · ${run.result.slice(0, 120)}` : ""}</li>)}
              </ul>
            )}
            <p className="text-muted-foreground mt-2 text-[11px]">Updated {new Date(autonomousActivity.fetched_at).toLocaleTimeString(i18n.resolvedLanguage)}. This lane reports host-side autonomous decisions; it does not claim provider success unless a model run actually completed.</p>
          </>
        )}
      </Card>

      <Card title={t("pages.activity.runningGoals", { defaultValue: "Running goals" })}>
        {running.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("pages.activity.noRunningGoals", { defaultValue: "No goals are running." })}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {running.map((goal) => (
              <li key={goal.id} className="flex flex-wrap items-center gap-3 text-sm">
                <IconLoader2 className="size-4 animate-spin" aria-hidden="true" />
                <span className="min-w-0 flex-1 font-medium">#{goal.id} {goal.title}</span>
                <span className="text-muted-foreground text-xs">{Math.round(goal.progress * 100)}%</span>
                {goal.run_id && <>
                  <Link to="/agent/monitor" className="border-border rounded-md border px-2 py-1 text-xs">Execution graph</Link>
                  <button type="button" disabled={goalBusy === goal.run_id} onClick={() => void handleCancelGoal(goal.run_id!)} className="border-border rounded-md border px-2 py-1 text-xs text-red-600 disabled:opacity-50">{goalBusy === goal.run_id ? "Stopping…" : "Stop run"}</button>
                </>}
              </li>
            ))}
          </ul>
        )}
        {(status?.recent_runs?.length ?? 0) > 0 && (
          <ul className="text-muted-foreground mt-3 flex flex-col gap-1 border-t pt-2 text-xs">
            {status!.recent_runs!.slice(0, 5).map((run) => (
              <li key={run.run_id} className="break-words">
                {t("pages.activity.goalLabel", { defaultValue: "Goal" })} #{run.goal_id} · {localStatus(run.status)} · {new Date(run.started_at).toLocaleTimeString(i18n.resolvedLanguage)}
                {run.error ? ` · ${run.error.slice(0, 80)}` : ""}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("pages.activity.backgroundJobs", { defaultValue: "Background jobs" })}>
        <p className="text-muted-foreground mb-2 text-xs">
          {t("pages.activity.backgroundJobsInfo", { defaultValue: "Long-running work continues independently and is restored after a Gateway restart." })}
        </p>
        {backgroundJobsError && <p role="alert" className="text-destructive mb-2 break-words text-xs">{backgroundJobsError}</p>}
        {backgroundJobs.length === 0 ? (
          <p className="text-muted-foreground text-sm">{backgroundJobsError ? "Background jobs are unavailable because the API request failed." : t("pages.activity.noBackgroundJobs", { defaultValue: "No background jobs yet." })}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {backgroundJobs.map((job) => {
              const terminal = ["completed", "failed", "cancelled", "superseded"].includes(job.status)
              const progress = job.progress == null ? null : Math.max(0, Math.min(100, Math.round(job.progress)))
              return (
                <li key={job.id} className="border-border/60 rounded-lg border p-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{job.goal}</div>
                      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span>{localStatus(job.status)}</span>
                        <span>·</span>
                        <span>{t("pages.activity.attempt", { defaultValue: "Attempt" })} {job.attempt}/{job.maxAttempts}</span>
                        <span>·</span>
                        <span>{new Date(job.updatedAt).toLocaleString(i18n.resolvedLanguage)}</span>
                      </div>
                    </div>
                    <button type="button" disabled={jobDetailBusy && selectedJobId === job.id} onClick={() => void loadBackgroundJobDetail(job.id)} className="border-border rounded-md border px-2 py-1 text-xs disabled:opacity-50">
                      {selectedJobId === job.id ? "Hide details" : "Details & events"}
                    </button>
                    {!terminal && (
                      <button type="button" disabled={backgroundJobBusy === job.id} onClick={() => void handleCancelBackgroundJob(job.id)} className="border-border rounded-md border px-2 py-1 text-xs disabled:opacity-50">
                        {backgroundJobBusy === job.id ? t("common.saving", { defaultValue: "Saving…" }) : t("common.cancel", { defaultValue: "Cancel" })}
                      </button>
                    )}
                  </div>
                  {progress !== null && (
                    <div className="mt-2">
                      <div className="mb-1 flex justify-between text-[11px] text-muted-foreground"><span>{t("pages.activity.progress", { defaultValue: "Progress" })}</span><span>{progress}%</span></div>
                      <div className="bg-muted h-1.5 overflow-hidden rounded-full"><div className="bg-primary h-full rounded-full transition-[width]" style={{ width: `${progress}%` }} /></div>
                    </div>
                  )}
                  {job.needsReconciliation && <p className="mt-2 text-xs text-amber-600">{t("pages.activity.needsReconciliation", { defaultValue: "An external action needs manual verification before this job can be retried." })}</p>}
                  {job.error && <p className="text-destructive mt-2 break-words whitespace-pre-wrap text-xs">{job.error}</p>}
                  {job.result && <p className="text-muted-foreground mt-2 line-clamp-3 break-words text-xs">{job.result}</p>}
                  {selectedJobId === job.id && (
                    <div className="border-border mt-3 space-y-2 border-t pt-3">
                      {jobDetailBusy && <p className="text-muted-foreground text-xs">Loading job history…</p>}
                      {jobDetailError && <p role="alert" className="text-destructive text-xs">{jobDetailError}</p>}
                      {selectedJobDetail && (
                        <>
                          <div className="text-xs font-medium">Task tree</div>
                          <pre className="bg-muted max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-[10px] leading-4">{safeJsonPreview(selectedJobDetail.tree)}</pre>
                          <div className="text-xs font-medium">Execution events ({selectedJobDetail.events.length})</div>
                          <pre className="bg-muted max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-[10px] leading-4">{safeJsonPreview(selectedJobDetail.events)}</pre>
                          {reconcileResult && <div className="rounded-md border p-2 text-xs"><div className="font-medium">Last reconciliation result</div><div className="mt-1">Resumed tasks: {reconcileResult.resumedTaskIds.length} · Remaining unsettled actions: {reconcileResult.remainingUnsettledActions.length}</div></div>}
                        </>
                      )}
                      {job.needsReconciliation && (
                        <div className="space-y-2 rounded-md border border-amber-500/40 p-3">
                          <p className="text-xs font-semibold">Manual external-state verification</p>
                          <p className="text-muted-foreground text-xs">Only submit this after independently checking the external system. This can resume work; it does not undo an external action.</p>
                          <label className="block text-xs">Evidence JSON<textarea rows={3} value={reconcileEvidence} onChange={(event) => setReconcileEvidence(event.target.value)} className="border-border bg-background mt-1 w-full rounded-md border p-2 font-mono text-xs" /></label>
                          <label className="block text-xs">Action outcomes JSON (use [] when no action needs reconciliation)<textarea rows={3} value={reconcileActions} onChange={(event) => setReconcileActions(event.target.value)} className="border-border bg-background mt-1 w-full rounded-md border p-2 font-mono text-xs" /></label>
                          <button type="button" disabled={reconcileBusy} onClick={() => void handleReconcileBackgroundJob(job.id)} className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-xs disabled:opacity-50">{reconcileBusy ? "Reconciling…" : "Submit verification & reconcile"}</button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card title={t("pages.activity.liveToolCalls", { defaultValue: "Live tool calls" })}>
        <p className="text-muted-foreground mb-2 text-[11px]">
          Recent and completed tool status metadata is loaded from the Gateway's persisted Monitor history. Sensitive tool inputs and outputs are not retained.
        </p>
        {monitorHistoryError && <p role="alert" className="text-destructive mb-2 text-xs">Server history: {monitorHistoryError}</p>}
        <p className={cn("mb-2 text-xs", connectionState === "connected" ? "text-emerald-600" : "text-amber-600")} role="status">
          {t("pages.activity.eventStreamStatus", { state: t(`pages.activity.connectionStates.${connectionState}`, { defaultValue: connectionState.replaceAll("_", " ") }), defaultValue: "Agent event stream: {{state}}" })}
        </p>
        {toolCalls.length === 0 ? (
          <p className="text-muted-foreground text-sm">{monitorHistoryError ? "Persisted activity history is unavailable. Check Gateway connectivity and refresh." : (connectionState === "connected" ? t("pages.activity.noToolCalls", { defaultValue: "No tool calls have been recorded yet." }) : t("pages.activity.noToolCallsDisconnected", { defaultValue: "No recorded tool calls. Reconnect to receive live events." }))}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {toolCalls.map((node) => (
              <li key={node.id} className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    node.status === "running" || node.status === "retrying" ? "animate-pulse bg-blue-500"
                      : node.status === "failed" ? "bg-red-500" : "bg-emerald-500",
                  )}
                />
                <span className="font-mono text-xs">{node.label}</span>
                <span className="text-muted-foreground ml-auto text-xs">
                  {localStatus(node.status)}{node.durationMs != null ? ` · ${node.durationMs} ms` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-[11px]">Showing {toolCalls.length} most recent recorded nodes</span>
          <button type="button" disabled={monitorHistoryLoading || monitorHistoryCursor === null} onClick={() => { setToolCallLimit((current) => current + 20); if (monitorHistoryCursor) void loadMonitorHistory(monitorHistoryCursor) }} className="border-border rounded-md border px-2.5 py-1 text-xs disabled:opacity-50">
            {monitorHistoryLoading ? "Loading history…" : monitorHistoryCursor ? "Load older activity" : "No older history"}
          </button>
        </div>
      </Card>

      <Card title="Event triggers">
        <p className="text-muted-foreground mb-3 text-xs">Create and manage event-driven tasks. The event name must match an event emitted by a connected integration or webhook.</p>
        {triggerError && <p role="alert" className="text-destructive mb-2 text-xs">{triggerError}</p>}
        <form className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-2" onSubmit={handleCreateTrigger}>
          <label className="flex flex-col gap-1 text-xs">Event name<input required maxLength={180} value={triggerName} onChange={(event) => setTriggerName(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm" placeholder="webhook:deployment-finished" /></label>
          <label className="flex flex-col gap-1 text-xs">Task title<input required maxLength={240} value={triggerTitle} onChange={(event) => setTriggerTitle(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm" placeholder="Inspect deployment" /></label>
          <label className="flex flex-col gap-1 text-xs md:col-span-2">Description<textarea rows={2} value={triggerDescription} onChange={(event) => setTriggerDescription(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm" /></label>
          <label className="flex flex-col gap-1 text-xs md:col-span-2">Payload filter (JSON object)<textarea rows={2} value={triggerFilter} onChange={(event) => setTriggerFilter(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 font-mono text-xs" /></label>
          <label className="flex flex-col gap-1 text-xs md:col-span-2">Acceptance contract (optional JSON; required when strict verification is enabled)<textarea rows={3} value={triggerAcceptance} onChange={(event) => setTriggerAcceptance(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 font-mono text-xs" placeholder='{"mode":"all","checks":[{"type":"tool_called","name":"file_write","status":"succeeded"}]}' /></label>
          <div className="md:col-span-2"><button type="submit" disabled={triggerBusy || !triggerName.trim() || !triggerTitle.trim()} className="bg-primary text-primary-foreground rounded-md px-3 py-2 text-xs font-medium disabled:opacity-50">{triggerBusy ? "Saving…" : "Create event trigger"}</button></div>
        </form>
        {triggers.length === 0 ? <p className="text-muted-foreground text-sm">{triggerError ? "Event triggers are unavailable because the API request failed." : "No event triggers found."}</p> : (
          <ul className="flex flex-col gap-2">
            {triggers.map((trigger) => {
              const enabled = trigger.enabled === true || trigger.enabled === 1
              return <li key={trigger.trigger_id} className="border-border/60 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("size-2 rounded-full", enabled ? "bg-emerald-500" : "bg-muted-foreground")} />
                  <div className="min-w-0 flex-1"><div className="text-sm font-medium">{trigger.title}</div><div className="text-muted-foreground font-mono text-xs">{trigger.event_name}</div></div>
                  <span className="text-muted-foreground text-xs">{enabled ? "Enabled" : "Disabled"}</span>
                  <button type="button" disabled={triggerBusy} onClick={() => void handleToggleTrigger(trigger)} className="border-border rounded-md border px-2 py-1 text-xs">{enabled ? "Disable" : "Enable"}</button>
                  <button type="button" disabled={triggerBusy} onClick={() => startEditingTrigger(trigger)} className="border-border rounded-md border px-2 py-1 text-xs">Edit</button>
                </div>
                {trigger.description && <p className="text-muted-foreground mt-1 text-xs">{trigger.description}</p>}
                {editingTriggerId === trigger.trigger_id && <div className="mt-3 grid gap-2 border-t pt-3">
                  <label className="text-xs">Title<input value={editTriggerTitle} onChange={(event) => setEditTriggerTitle(event.target.value)} className="border-border bg-background mt-1 w-full rounded-md border px-2 py-1.5 text-xs" /></label>
                  <label className="text-xs">Description<textarea rows={2} value={editTriggerDescription} onChange={(event) => setEditTriggerDescription(event.target.value)} className="border-border bg-background mt-1 w-full rounded-md border px-2 py-1.5 text-xs" /></label>
                  <label className="text-xs">Filter JSON<textarea rows={2} value={editTriggerFilter} onChange={(event) => setEditTriggerFilter(event.target.value)} className="border-border bg-background mt-1 w-full rounded-md border px-2 py-1.5 font-mono text-xs" /></label>
                  <div className="flex gap-2"><button type="button" disabled={triggerBusy} onClick={() => void saveTriggerEdit(trigger.trigger_id)} className="bg-primary text-primary-foreground rounded-md px-2.5 py-1.5 text-xs">Save</button><button type="button" onClick={() => setEditingTriggerId(null)} className="border-border rounded-md border px-2.5 py-1.5 text-xs">Discard</button></div>
                </div>}
              </li>
            })}
          </ul>
        )}
      </Card>

      <Card title="Live screen share">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {!screenStream ? (
            <button type="button" disabled={screenShareStarting} onClick={() => void startScreenShare()} className="bg-primary text-primary-foreground inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium disabled:opacity-50">
              {screenShareStarting ? <IconLoader2 className="size-4 animate-spin" /> : <IconScreenShare className="size-4" />} {screenShareStarting ? "Waiting for permission…" : "Share screen live"}
            </button>
          ) : (
            <button type="button" onClick={stopScreenShare} className="inline-flex items-center gap-1.5 rounded-md border border-red-500/50 px-3 py-2 text-xs text-red-600">
              <IconPlayerStop className="size-4" /> Stop sharing
            </button>
          )}
          <span className={cn("text-xs", screenStream ? "text-emerald-600" : "text-muted-foreground")} role="status">
            {screenStream ? "Live browser media stream" : "Not sharing"}
          </span>
        </div>
        {screenShareError && <p role="alert" className="text-destructive mb-2 text-xs">{screenShareError}</p>}
        <video
          ref={screenVideoRef}
          autoPlay
          muted
          playsInline
          controls={false}
          className={cn("border-border max-h-[65svh] w-full rounded-md border bg-black object-contain", !screenStream && "hidden")}
          aria-label="Live shared screen preview"
        />
        {!screenStream && (
          <p className="text-muted-foreground rounded-md border border-dashed py-8 text-center text-sm">
            Choose “Share screen live” and select a screen or window in the browser permission dialog.
          </p>
        )}
        <p className="text-muted-foreground mt-2 text-xs">
          The browser streams selected display frames directly to this page as a MediaStream; no periodic PNG/JPEG screenshots are created here. Browser permission is required and sharing stops when you stop it or leave this page.
        </p>
        <p className="mt-1 text-xs text-amber-600">
          This version previews the stream in Activity. It does not yet forward the live video to Miki’s model/runtime; Miki’s desktop-control tools still use their existing computer-observation pipeline.
        </p>
      </Card>

      <Card title={t("pages.activity.cronSchedules", { defaultValue: "Scheduled tasks" })}>
        <p className="text-muted-foreground mb-3 text-xs">
          Schedules create Miki tasks; they do not run arbitrary shell commands. One-time, interval, and cron schedules are supported.
        </p>
        <form className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-2" onSubmit={handleCreateCron}>
          <label className="flex flex-col gap-1 text-xs md:col-span-2">Schedule type
            <select value={scheduleType} onChange={(event) => setScheduleType(event.target.value as "cron" | "once" | "interval")} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm">
              <option value="once">One time</option><option value="interval">Repeat by interval</option><option value="cron">Cron</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {t("pages.activity.taskTitle", { defaultValue: "Task title" })}
            <input required maxLength={240} value={cronTitle} onChange={(event) => setCronTitle(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm" placeholder={t("pages.activity.taskPlaceholder", { defaultValue: "Weekday morning review" })} />
          </label>
          {scheduleType === "cron" ? <>
            <label className="flex flex-col gap-1 text-xs">{t("pages.activity.cronExpression", { defaultValue: "Cron expression" })}<input required value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 font-mono text-sm" placeholder="0 9 * * 1-5" /></label>
            <label className="flex flex-col gap-1 text-xs">{t("pages.activity.timezone", { defaultValue: "Time zone" })}<input required value={cronTimezone} onChange={(event) => setCronTimezone(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm" placeholder="Asia/Dhaka" /></label>
            <label className="flex flex-col gap-1 text-xs">{t("pages.activity.missedRunPolicy", { defaultValue: "Missed-run policy" })}<select value={cronMisfirePolicy} onChange={(event) => setCronMisfirePolicy(event.target.value as "skip" | "run_once")} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm"><option value="skip">{t("pages.activity.skipMissed", { defaultValue: "Skip missed runs" })}</option><option value="run_once">{t("pages.activity.runOnce", { defaultValue: "Run once after recovery" })}</option></select></label>
          </> : scheduleType === "once" ? (
            <label className="flex flex-col gap-1 text-xs">Run at (local time)<input required type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm" /></label>
          ) : (
            <label className="flex flex-col gap-1 text-xs">Repeat interval (seconds, minimum 60)<input required type="number" min={60} max={31536000} step={1} value={intervalSeconds} onChange={(event) => setIntervalSeconds(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm" /></label>
          )}
          <label className="flex flex-col gap-1 text-xs md:col-span-2">
            {t("pages.activity.descriptionOptional", { defaultValue: "Description (optional)" })}
            <textarea rows={2} value={cronDescription} onChange={(event) => setCronDescription(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm" placeholder={t("pages.activity.descriptionPlaceholder", { defaultValue: "What should Miki inspect or accomplish?" })} />
          </label>
          <label className="flex flex-col gap-1 text-xs md:col-span-2">Acceptance contract (optional JSON; required when strict verification is enabled)
            <textarea rows={3} value={scheduleAcceptance} onChange={(event) => setScheduleAcceptance(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 font-mono text-xs" placeholder='{"mode":"all","checks":[{"type":"tool_called","name":"file_write","status":"succeeded"}]}' />
          </label>
          <div className="md:col-span-2">
            <button type="submit" disabled={scheduleBusy || !cronTitle.trim()} className="bg-primary text-primary-foreground rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50">
              {scheduleBusy ? t("common.saving", { defaultValue: "Saving…" }) : t("pages.activity.createSchedule", { defaultValue: "Create schedule" })}
            </button>
          </div>
        </form>
        {scheduleError && <p role="alert" className="text-destructive mb-3 text-sm">{scheduleError}</p>}
        {scheduleLoaded && scheduledTasks.length >= 100 && <p className="text-muted-foreground mb-2 text-xs">Showing {scheduledTasks.length} schedules (offset {scheduleOffset}). Load older schedules to view more.</p>}
        {!scheduleLoaded && !scheduleError ? <p className="text-muted-foreground text-sm">Loading schedules…</p> : scheduledTasks.length === 0 ? (
          <p className="text-muted-foreground text-sm">{scheduleError ? "Schedules could not be loaded." : t("pages.activity.noSchedules", { defaultValue: "No scheduled tasks yet." })}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {scheduledTasks.map((task) => (
              <li key={task.task_id} className="border-border/60 rounded-lg border p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{task.title}</div>
                    <div className="text-muted-foreground mt-1 font-mono text-xs">{scheduleTypeOf(task) === "cron" ? `${task.cron_expression} · ${task.timezone}` : scheduleTypeOf(task) === "interval" ? `Every ${task.interval_seconds ?? 0} seconds` : "One-time task"}</div>
                    <div className="text-muted-foreground mt-1 text-xs">
                      {t("pages.activity.next", { defaultValue: "Next" })}: {task.next_run_at ? new Date(task.next_run_at).toLocaleString(i18n.resolvedLanguage) : new Date(task.due_at).toLocaleString(i18n.resolvedLanguage)} · {t("pages.activity.status", { defaultValue: "Status" })}: {localStatus(task.status)} · {t("pages.activity.missed", { defaultValue: "Missed" })}: {task.missed_runs ?? 0}
                    </div>
                    {task.last_run_at && <div className="text-muted-foreground mt-1 text-xs">{t("pages.activity.lastRun", { defaultValue: "Last run" })}: {new Date(task.last_run_at).toLocaleString(i18n.resolvedLanguage)} · {localStatus(task.last_outcome ?? "unknown")}</div>}
                    {task.last_error && <div className="mt-1 break-words whitespace-pre-wrap text-xs text-red-600">{task.last_error}</div>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {task.status === "paused" ? (
                      <button type="button" disabled={scheduleBusy} onClick={() => void runScheduleAction(() => resumeScheduledTask(task.task_id))} className="border-border rounded-md border px-2 py-1 text-xs">{t("pages.activity.resume", { defaultValue: "Resume" })}</button>
                    ) : task.status === "scheduled" ? (
                      <button type="button" disabled={scheduleBusy} onClick={() => void runScheduleAction(() => pauseScheduledTask(task.task_id))} className="border-border rounded-md border px-2 py-1 text-xs">{t("pages.activity.pause", { defaultValue: "Pause" })}</button>
                    ) : null}
                    {task.status === "scheduled" || task.status === "paused" || task.status === "queued" ? (
                      <button type="button" disabled={scheduleBusy} onClick={() => void runScheduleAction(() => cancelScheduledTask(task.task_id))} className="border-border rounded-md border px-2 py-1 text-xs">{t("common.cancel", { defaultValue: "Cancel" })}</button>
                    ) : null}
                    {!(["scheduled", "paused", "queued"].includes(task.status)) && <span className="text-muted-foreground self-center text-[11px]">No schedule actions for this state</span>}
                    {(task.status === "scheduled" || task.status === "paused") && editingTaskId !== task.task_id && (
                      <button type="button" disabled={scheduleBusy} onClick={() => startEditingTask(task)} className="border-border rounded-md border px-2 py-1 text-xs">{t("common.edit", { defaultValue: "Edit" })}</button>
                    )}
                  </div>
                </div>
                {editingTaskId === task.task_id && (
                  <div className="border-border mt-3 grid grid-cols-1 gap-2 border-t pt-3 md:grid-cols-3">
                    <label className="flex flex-col gap-1 text-xs md:col-span-2">Task title<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={240} className="border-border bg-background rounded-md border px-2 py-1.5 text-xs" /></label>
                    {scheduleTypeOf(task) === "cron" ? <>
                      <label className="flex flex-col gap-1 text-xs">{t("pages.activity.cronExpression", { defaultValue: "Cron expression" })}<input value={editExpression} onChange={(event) => setEditExpression(event.target.value)} className="border-border bg-background rounded-md border px-2 py-1.5 font-mono text-xs" /></label>
                      <label className="flex flex-col gap-1 text-xs">{t("pages.activity.timezone", { defaultValue: "Time zone" })}<input value={editTimezone} onChange={(event) => setEditTimezone(event.target.value)} className="border-border bg-background rounded-md border px-2 py-1.5 text-xs" /></label>
                      <label className="flex flex-col gap-1 text-xs">{t("pages.activity.missedRunPolicy", { defaultValue: "Missed-run policy" })}<select value={editMisfirePolicy} onChange={(event) => setEditMisfirePolicy(event.target.value as "skip" | "run_once")} className="border-border bg-background rounded-md border px-2 py-1.5 text-xs"><option value="skip">{t("pages.activity.skipMissed", { defaultValue: "Skip missed runs" })}</option><option value="run_once">{t("pages.activity.runOnce", { defaultValue: "Run once after recovery" })}</option></select></label>
                    </> : <>
                      <label className="flex flex-col gap-1 text-xs">{scheduleTypeOf(task) === "interval" ? "Next run at (local time, optional)" : "Run at (local time)"}<input type="datetime-local" required={scheduleTypeOf(task) !== "interval"} value={editDueAt} onChange={(event) => setEditDueAt(event.target.value)} className="border-border bg-background rounded-md border px-2 py-1.5 text-xs" /></label>
                      {scheduleTypeOf(task) === "interval" && <label className="flex flex-col gap-1 text-xs">Repeat interval (seconds, minimum 60)<input type="number" min={60} max={31536000} step={1} value={editIntervalSeconds} onChange={(event) => setEditIntervalSeconds(event.target.value)} className="border-border bg-background rounded-md border px-2 py-1.5 text-xs" /></label>}
                    </>}
                    <label className="flex flex-col gap-1 text-xs md:col-span-3">Description<textarea rows={2} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} className="border-border bg-background rounded-md border px-2 py-1.5 text-xs" /></label>
                    <div className="flex gap-2 md:col-span-3"><button type="button" disabled={scheduleBusy} onClick={() => void saveTaskEdit(task)} className="bg-primary text-primary-foreground rounded-md px-2.5 py-1.5 text-xs">{t("common.save", { defaultValue: "Save" })}</button><button type="button" onClick={() => setEditingTaskId(null)} className="border-border rounded-md border px-2.5 py-1.5 text-xs">{t("pages.activity.discard", { defaultValue: "Discard" })}</button></div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {scheduleHasMore && (
          <div className="mt-3 text-center">
            <button type="button" disabled={scheduleBusy} onClick={() => void loadScheduledTasks(true)} className="border-border rounded-md border px-3 py-1.5 text-xs disabled:opacity-50">
              Load older schedules
            </button>
          </div>
        )}
      </Card>

      <Card title={t("pages.activity.learnedRules", { defaultValue: "Learned rules" })}>
        {rulesError && <p role="alert" className="text-destructive mb-2 break-words text-xs">Could not load or update learned rules: {rulesError}</p>}
        {rulesLoading ? <p className="text-muted-foreground text-sm">Loading learned rules…</p> : rules.length === 0 ? (
          <p className="text-muted-foreground text-sm">{rulesError ? "Rules are unavailable because the API request failed." : t("pages.activity.noRules", { defaultValue: "No rules yet. Everything is allowed until you teach Miki otherwise." })}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rules.map((rule) => {
              const key = `${rule.category}\u0000${rule.match}`
              return <li key={key} className="flex items-start gap-3 text-sm">
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", DECISION_STYLE[rule.decision])}>{t(`pages.activity.decisions.${rule.decision}`, { defaultValue: rule.decision })}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs">{rule.category}{rule.match ? ` · "${rule.match}"` : ""}</div>
                  {rule.note && <div className="text-muted-foreground truncate text-xs">{rule.note}</div>}
                </div>
                <button type="button" disabled={ruleBusy === key} aria-label={t("pages.activity.removeRule", { category: rule.category, defaultValue: `Remove rule ${rule.category}` })} className="text-muted-foreground hover:text-red-600 disabled:opacity-50" onClick={() => void handleDeleteRule(rule)}>
                  {ruleBusy === key ? <IconLoader2 className="size-4 animate-spin" /> : <IconTrash className="size-4" />}
                </button>
              </li>
            })}
          </ul>
        )}
      </Card>
    </div>
      </div>
  )
}
