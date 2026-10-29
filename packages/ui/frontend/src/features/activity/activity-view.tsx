import { IconActivity, IconCamera, IconLoader2, IconTrash } from "@tabler/icons-react"
import { atom, useAtomValue } from "jotai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { PageHeader } from "@/app/layout/page-header"
import { monitorAtom } from "@/features/monitor/store"
import { cn } from "@/lib/utils"

import {
  cancelScheduledTask,
  createCronTask,
  forgetLearnedRule,
  getAutonomyStatus,
  getLearnedRules,
  getScheduledTasks,
  getScreenshot,
  pauseScheduledTask,
  resumeScheduledTask,
  updateScheduledTask,
  type AutonomyStatus,
  type LearnedRule,
  type ScheduledTask,
} from "./activity-api"

const STATUS_POLL_MS = 5000
const TASK_POLL_MS = 30000
const SHOT_MS = 5000
const monitorNodesAtom = atom((get) => get(monitorAtom).nodes)

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

const DECISION_STYLE: Record<LearnedRule["decision"], string> = {
  act: "bg-emerald-500/15 text-emerald-600",
  ask: "bg-amber-500/15 text-amber-600",
  block: "bg-red-500/15 text-red-600",
}

/** One page: running goals, live tool calls, the desktop screenshot, and the rules Miki has learned. */
export function ActivityView() {
  const { t, i18n } = useTranslation()
  const localStatus = (value?: string) => {
    if (!value) return t("pages.activity.statuses.unknown", { defaultValue: "Unknown" })
    const key = value.toLowerCase().replaceAll("-", "_")
    return t(`pages.activity.statuses.${key}`, {
      defaultValue: value.replaceAll("_", " "),
    })
  }
  const [status, setStatus] = useState<AutonomyStatus | null>(null)
  const [statusError, setStatusError] = useState<string>()
  const [rules, setRules] = useState<LearnedRule[]>([])
  const [shot, setShot] = useState<{ src: string; at: string }>()
  const [shotError, setShotError] = useState<string>()
  const [shotBusy, setShotBusy] = useState(false)
  const shotInFlight = useRef(false)
  const [autoShot, setAutoShot] = useState(false)
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([])
  const [scheduleError, setScheduleError] = useState<string>()
  const [scheduleBusy, setScheduleBusy] = useState(false)
  const [cronTitle, setCronTitle] = useState("")
  const [cronDescription, setCronDescription] = useState("")
  const [cronExpression, setCronExpression] = useState("0 9 * * 1-5")
  const [cronTimezone, setCronTimezone] = useState("Asia/Dhaka")
  const [cronMisfirePolicy, setCronMisfirePolicy] = useState<"skip" | "run_once">("skip")
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null)
  const [editExpression, setEditExpression] = useState("")
  const [editTimezone, setEditTimezone] = useState("Asia/Dhaka")
  const [editMisfirePolicy, setEditMisfirePolicy] = useState<"skip" | "run_once">("skip")
  const monitorNodes = useAtomValue(monitorNodesAtom)

  useEffect(() => {
    let stopped = false
    let inFlight = false
    const load = async () => {
      if (stopped || document.visibilityState !== "visible" || inFlight) return
      inFlight = true
      try {
        const next = await getAutonomyStatus()
        if (!stopped) { setStatus(next); setStatusError(undefined) }
      } catch (error) {
        if (!stopped) setStatusError(error instanceof Error ? error.message : String(error))
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

  const loadScheduledTasks = useCallback(async () => {
    try {
      const next = await getScheduledTasks(100)
      setScheduledTasks(next.tasks.filter((task) => task.schedule_type === "cron"))
      setScheduleError(undefined)
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error))
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
      await createCronTask({
        title: cronTitle,
        description: cronDescription,
        cron_expression: cronExpression,
        timezone: cronTimezone,
        misfire_policy: cronMisfirePolicy,
      })
      setCronTitle("")
      setCronDescription("")
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

  const startEditingCron = (task: ScheduledTask) => {
    setEditingTaskId(task.task_id)
    setEditExpression(task.cron_expression ?? "")
    setEditTimezone(task.timezone ?? "Asia/Dhaka")
    setEditMisfirePolicy(task.misfire_policy === "run_once" ? "run_once" : "skip")
  }

  const saveCronEdit = async (taskId: number) => {
    await runScheduleAction(async () => {
      await updateScheduledTask(taskId, {
        cron_expression: editExpression,
        timezone: editTimezone,
        misfire_policy: editMisfirePolicy,
      })
      setEditingTaskId(null)
    })
  }

  const loadRules = useCallback(async () => {
    try { setRules((await getLearnedRules()).rules) } catch { /* the list simply stays empty */ }
  }, [])
  useEffect(() => { void loadRules() }, [loadRules])

  const takeShot = useCallback(async () => {
    if (shotInFlight.current || document.visibilityState !== "visible") return
    shotInFlight.current = true
    setShotBusy(true)
    try {
      const result = await getScreenshot()
      setShot({ src: `data:image/png;base64,${result.png_base64}`, at: result.captured_at })
      setShotError(undefined)
    } catch (error) {
      setShotError(error instanceof Error ? error.message : String(error))
    } finally {
      shotInFlight.current = false
      setShotBusy(false)
    }
  }, [])
  useEffect(() => {
    if (!autoShot) return
    void takeShot()
    const timer = window.setInterval(() => void takeShot(), SHOT_MS)
    return () => window.clearInterval(timer)
  }, [autoShot, takeShot])

  const toolCalls = useMemo(
    () => Object.values(monitorNodes).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20),
    [monitorNodes],
  )
  const running = status?.running_goals ?? []

  return (
    <div className="flex h-full min-h-0 flex-col" data-miki-page="activity">
      <PageHeader title={t("pages.activity.title", { defaultValue: "Activity" })} titleLevel={1} />
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6" data-miki-page-body="true">
      <div className="flex items-center gap-2">
        <IconActivity className="text-primary size-5" aria-hidden="true" />
        {status && (
          <span className="text-muted-foreground text-xs">
            {t("pages.activity.runningSummary", { count: running.length, max: status.max_concurrent_tasks ?? 1, defaultValue: "{{count}} / {{max}} running" })}{status.paused ? ` · ${t("pages.activity.paused", { defaultValue: "Paused" })}` : ""}
          </span>
        )}
      </div>
      {statusError && <p role="alert" className="text-destructive text-sm">{statusError}</p>}

      <Card title={t("pages.activity.runningGoals", { defaultValue: "Running goals" })}>
        {running.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("pages.activity.noRunningGoals", { defaultValue: "No goals are running." })}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {running.map((goal) => (
              <li key={goal.id} className="flex items-center gap-3 text-sm">
                <IconLoader2 className="size-4 animate-spin" aria-hidden="true" />
                <span className="font-medium">#{goal.id} {goal.title}</span>
                <span className="text-muted-foreground ml-auto text-xs">
                  {Math.round(goal.progress * 100)}%
                </span>
              </li>
            ))}
          </ul>
        )}
        {(status?.recent_runs?.length ?? 0) > 0 && (
          <ul className="text-muted-foreground mt-3 flex flex-col gap-1 border-t pt-2 text-xs">
            {status!.recent_runs!.slice(0, 5).map((run) => (
              <li key={run.run_id}>
                {t("pages.activity.goalLabel", { defaultValue: "Goal" })} #{run.goal_id} · {localStatus(run.status)} · {new Date(run.started_at).toLocaleTimeString(i18n.resolvedLanguage)}
                {run.error ? ` · ${run.error.slice(0, 80)}` : ""}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("pages.activity.liveToolCalls", { defaultValue: "Live tool calls" })}>
        {toolCalls.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("pages.activity.noToolCalls", { defaultValue: "No tool calls yet." })}</p>
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
      </Card>

      <Card title={t("pages.activity.screen", { defaultValue: "Screen" })}>
        <div className="mb-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void takeShot()}
            disabled={shotBusy}
            className="border-border hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs"
          >
            {shotBusy ? <IconLoader2 className="size-3.5 animate-spin" /> : <IconCamera className="size-3.5" />}
            {t("pages.activity.capture", { defaultValue: "Capture" })}
          </button>
          <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={autoShot} onChange={(e) => setAutoShot(e.target.checked)} />
            {t("pages.activity.autoRefresh", { defaultValue: "Auto refresh" })}
          </label>
          {shot && <span className="text-muted-foreground ml-auto text-xs">{new Date(shot.at).toLocaleTimeString(i18n.resolvedLanguage)}</span>}
        </div>
        {shotError && <p role="alert" className="text-destructive text-sm">{shotError}</p>}
        {shot && <img src={shot.src} alt={t("pages.activity.currentScreen", { defaultValue: "Current desktop screen" })} className="border-border max-h-[55svh] w-full rounded-md border bg-muted/20 object-contain object-top" />}
      </Card>

      <Card title={t("pages.activity.cronSchedules", { defaultValue: "Scheduled tasks" })}>
        <p className="text-muted-foreground mb-3 text-xs">
          {t("pages.activity.cronHelp", { defaultValue: "Use minute, hour, day, month, and weekday fields. Schedules create Miki tasks; they do not run arbitrary shell commands." })}
        </p>
        <form className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-2" onSubmit={handleCreateCron}>
          <label className="flex flex-col gap-1 text-xs">
            {t("pages.activity.taskTitle", { defaultValue: "Task title" })}
            <input required maxLength={240} value={cronTitle} onChange={(event) => setCronTitle(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm" placeholder={t("pages.activity.taskPlaceholder", { defaultValue: "Weekday morning review" })} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {t("pages.activity.cronExpression", { defaultValue: "Cron expression" })}
            <input required value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 font-mono text-sm" placeholder="0 9 * * 1-5" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {t("pages.activity.timezone", { defaultValue: "Time zone" })}
            <input required value={cronTimezone} onChange={(event) => setCronTimezone(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm" placeholder="Asia/Dhaka" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {t("pages.activity.missedRunPolicy", { defaultValue: "Missed-run policy" })}
            <select value={cronMisfirePolicy} onChange={(event) => setCronMisfirePolicy(event.target.value as "skip" | "run_once")} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm">
              <option value="skip">{t("pages.activity.skipMissed", { defaultValue: "Skip missed runs" })}</option>
              <option value="run_once">{t("pages.activity.runOnce", { defaultValue: "Run once after recovery" })}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs md:col-span-2">
            {t("pages.activity.descriptionOptional", { defaultValue: "Description (optional)" })}
            <textarea rows={2} value={cronDescription} onChange={(event) => setCronDescription(event.target.value)} className="border-border bg-background rounded-md border px-2.5 py-2 text-sm" placeholder={t("pages.activity.descriptionPlaceholder", { defaultValue: "What should Miki inspect or accomplish?" })} />
          </label>
          <div className="md:col-span-2">
            <button type="submit" disabled={scheduleBusy || !cronTitle.trim()} className="bg-primary text-primary-foreground rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50">
              {scheduleBusy ? t("common.saving", { defaultValue: "Saving…" }) : t("pages.activity.createSchedule", { defaultValue: "Create schedule" })}
            </button>
          </div>
        </form>
        {scheduleError && <p role="alert" className="text-destructive mb-3 text-sm">{scheduleError}</p>}
        {scheduledTasks.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("pages.activity.noSchedules", { defaultValue: "No scheduled tasks yet." })}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {scheduledTasks.map((task) => (
              <li key={task.task_id} className="border-border/60 rounded-lg border p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{task.title}</div>
                    <div className="text-muted-foreground mt-1 font-mono text-xs">{task.cron_expression} · {task.timezone}</div>
                    <div className="text-muted-foreground mt-1 text-xs">
                      {t("pages.activity.next", { defaultValue: "Next" })}: {task.next_run_at ? new Date(task.next_run_at).toLocaleString(i18n.resolvedLanguage) : new Date(task.due_at).toLocaleString(i18n.resolvedLanguage)} · {t("pages.activity.status", { defaultValue: "Status" })}: {localStatus(task.status)} · {t("pages.activity.missed", { defaultValue: "Missed" })}: {task.missed_runs ?? 0}
                    </div>
                    {task.last_run_at && <div className="text-muted-foreground mt-1 text-xs">{t("pages.activity.lastRun", { defaultValue: "Last run" })}: {new Date(task.last_run_at).toLocaleString(i18n.resolvedLanguage)} · {localStatus(task.last_outcome ?? "unknown")}</div>}
                    {task.last_error && <div className="mt-1 text-xs text-red-600">{task.last_error}</div>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {task.status === "paused" ? (
                      <button type="button" disabled={scheduleBusy} onClick={() => void runScheduleAction(() => resumeScheduledTask(task.task_id))} className="border-border rounded-md border px-2 py-1 text-xs">{t("pages.activity.resume", { defaultValue: "Resume" })}</button>
                    ) : task.status === "scheduled" ? (
                      <button type="button" disabled={scheduleBusy} onClick={() => void runScheduleAction(() => pauseScheduledTask(task.task_id))} className="border-border rounded-md border px-2 py-1 text-xs">{t("pages.activity.pause", { defaultValue: "Pause" })}</button>
                    ) : null}
                    {task.status === "scheduled" || task.status === "paused" ? (
                      <button type="button" disabled={scheduleBusy} onClick={() => void runScheduleAction(() => cancelScheduledTask(task.task_id))} className="border-border rounded-md border px-2 py-1 text-xs">{t("common.cancel", { defaultValue: "Cancel" })}</button>
                    ) : null}
                    {(task.status === "scheduled" || task.status === "paused") && editingTaskId !== task.task_id && (
                      <button type="button" disabled={scheduleBusy} onClick={() => startEditingCron(task)} className="border-border rounded-md border px-2 py-1 text-xs">{t("common.edit", { defaultValue: "Edit" })}</button>
                    )}
                  </div>
                </div>
                {editingTaskId === task.task_id && (
                  <div className="border-border mt-3 grid grid-cols-1 gap-2 border-t pt-3 md:grid-cols-3">
                    <label className="flex flex-col gap-1 text-xs">{t("pages.activity.cronExpression", { defaultValue: "Cron expression" })}<input value={editExpression} onChange={(event) => setEditExpression(event.target.value)} className="border-border bg-background rounded-md border px-2 py-1.5 font-mono text-xs" /></label>
                    <label className="flex flex-col gap-1 text-xs">{t("pages.activity.timezone", { defaultValue: "Time zone" })}<input value={editTimezone} onChange={(event) => setEditTimezone(event.target.value)} className="border-border bg-background rounded-md border px-2 py-1.5 text-xs" /></label>
                    <label className="flex flex-col gap-1 text-xs">{t("pages.activity.missedRunPolicy", { defaultValue: "Missed-run policy" })}<select value={editMisfirePolicy} onChange={(event) => setEditMisfirePolicy(event.target.value as "skip" | "run_once")} className="border-border bg-background rounded-md border px-2 py-1.5 text-xs"><option value="skip">{t("pages.activity.skipMissed", { defaultValue: "Skip missed runs" })}</option><option value="run_once">{t("pages.activity.runOnce", { defaultValue: "Run once after recovery" })}</option></select></label>
                    <div className="flex gap-2 md:col-span-3"><button type="button" disabled={scheduleBusy} onClick={() => void saveCronEdit(task.task_id)} className="bg-primary text-primary-foreground rounded-md px-2.5 py-1.5 text-xs">{t("common.save", { defaultValue: "Save" })}</button><button type="button" onClick={() => setEditingTaskId(null)} className="border-border rounded-md border px-2.5 py-1.5 text-xs">{t("pages.activity.discard", { defaultValue: "Discard" })}</button></div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("pages.activity.learnedRules", { defaultValue: "Learned rules" })}>
        {rules.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("pages.activity.noRules", { defaultValue: "No rules yet. Everything is allowed until you teach Miki otherwise." })}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rules.map((rule) => (
              <li key={`${rule.category}\u0000${rule.match}`} className="flex items-start gap-3 text-sm">
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", DECISION_STYLE[rule.decision])}>
                  {t(`pages.activity.decisions.${rule.decision}`, { defaultValue: rule.decision })}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs">{rule.category}{rule.match ? ` · "${rule.match}"` : ""}</div>
                  {rule.note && <div className="text-muted-foreground truncate text-xs">{rule.note}</div>}
                </div>
                <button
                  type="button"
                  aria-label={t("pages.activity.removeRule", { category: rule.category, defaultValue: `Remove rule ${rule.category}` })}
                  className="text-muted-foreground hover:text-red-600"
                  onClick={() => void forgetLearnedRule(rule.category, rule.match).then(loadRules)}
                >
                  <IconTrash className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
      </div>
  )
}
