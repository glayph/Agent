import {
  IconCheck,
  IconLoader2,
  IconSparkles,
  IconX,
} from "@tabler/icons-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  type PursueGoalSnapshot,
  createPursueGoal,
  getPursueGoal,
  updatePursueGoal,
} from "@/api/goals"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

function progressLabel(snapshot: PursueGoalSnapshot | null): string {
  if (!snapshot?.active) return "0%"
  return `${Math.round(Math.max(0, Math.min(1, snapshot.summary.progress)) * 100)}%`
}

function statusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "active") return "default"
  if (status === "pending") return "secondary"
  return "outline"
}

function parseSteps(value: string): string[] | undefined {
  const steps = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  return steps.length > 0 ? steps : undefined
}

interface PursueGoalPanelProps {
  autoOpen?: boolean
  onAutoOpenConsumed?: () => void
}

export function PursueGoalPanel({ autoOpen, onAutoOpenConsumed }: PursueGoalPanelProps) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<PursueGoalSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const [objective, setObjective] = useState("")
  const [description, setDescription] = useState("")
  const [steps, setSteps] = useState("")

  const activeGoal = snapshot?.active ?? null
  const progress = useMemo(
    () => Math.max(0, Math.min(1, snapshot?.summary.progress ?? 0)),
    [snapshot?.summary.progress],
  )

  const loadGoal = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await getPursueGoal())
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("pursueGoal.toast.loadFailed"),
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadGoal()
  }, [loadGoal])

  useEffect(() => {
    if (autoOpen && !loading && !activeGoal) {
      setOpen(true)
      onAutoOpenConsumed?.()
    }
  }, [autoOpen, loading, activeGoal, onAutoOpenConsumed])

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!objective.trim()) return
    setSaving(true)
    try {
      setSnapshot(
        await createPursueGoal({
          objective: objective.trim(),
          description: description.trim() || undefined,
          steps: parseSteps(steps),
          replaceExisting: Boolean(activeGoal),
        }),
      )
      setObjective("")
      setDescription("")
      setSteps("")
      setOpen(false)
      toast.success(t("pursueGoal.toast.started"))
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("pursueGoal.toast.startFailed"),
      )
    } finally {
      setSaving(false)
    }
  }

  const handleStatus = async (
    status: "completed" | "blocked" | "cancelled",
  ) => {
    if (!activeGoal) return
    setSaving(true)
    try {
      setSnapshot(
        await updatePursueGoal(activeGoal.id, {
          status,
          statusReason:
            status === "completed"
              ? t("pursueGoal.statusReason.completed")
              : t("pursueGoal.statusReason.stopped"),
        }),
      )
      toast.success(
        t("pursueGoal.toast.statusUpdated", {
          status: t(`pursueGoal.status.${status}`),
        }),
      )
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("pursueGoal.toast.updateFailed"),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="bg-card/35 px-[var(--chat-inline-padding)] py-2">
        <div className="mx-auto flex min-h-9 w-full max-w-[var(--chat-content-width)] items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <IconSparkles className="text-muted-foreground size-4 shrink-0" />
            {loading ? (
              <span className="text-muted-foreground text-sm">
                {t("pursueGoal.loading")}
              </span>
            ) : activeGoal ? (
              <>
                <Badge
                  variant={statusVariant(activeGoal.status)}
                  className="capitalize"
                >
                  {t(`pursueGoal.status.${activeGoal.status}`)}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {activeGoal.title}
                  </div>
                  <div
                    className="bg-muted mt-1 h-1.5 w-full overflow-hidden rounded-full"
                    role="progressbar"
                    aria-label={t("pursueGoal.progress")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progress * 100)}
                  >
                    <div
                      className="bg-primary h-full rounded-full"
                      style={{ width: `${progress * 100}%` }}
                    />
                  </div>
                </div>
                <span className="text-muted-foreground hidden text-xs sm:inline">
                  {progressLabel(snapshot)}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground truncate text-sm">
                {t("pursueGoal.noActive")}
              </span>
            )}
          </div>

          {activeGoal ? (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={t("pursueGoal.actions.complete")}
                aria-label={t("pursueGoal.actions.complete")}
                disabled={saving}
                onClick={() => void handleStatus("completed")}
              >
                {saving ? (
                  <IconLoader2 className="size-4 animate-spin" />
                ) : (
                  <IconCheck className="size-4" />
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => void handleStatus("blocked")}
              >
                {t("pursueGoal.actions.block")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={t("pursueGoal.actions.cancel")}
                aria-label={t("pursueGoal.actions.cancel")}
                disabled={saving}
                onClick={() => void handleStatus("cancelled")}
              >
                <IconX className="size-4" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              title={t("pursueGoal.title")}
              aria-label={t("pursueGoal.title")}
              onClick={() => setOpen(true)}
            >
              <IconSparkles className="size-4" />
              <span className="hidden sm:inline">{t("pursueGoal.title")}</span>
            </Button>
          )}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("pursueGoal.title")}</DialogTitle>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={handleCreate}>
            <div className="grid gap-2">
              <label className="text-sm font-medium" htmlFor="goal-objective">
                {t("pursueGoal.fields.objective")}
              </label>
              <Input
                id="goal-objective"
                name="pursue_goal_objective"
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                autoComplete="off"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium" htmlFor="goal-details">
                {t("pursueGoal.fields.details")}
              </label>
              <Textarea
                id="goal-details"
                name="pursue_goal_details"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="min-h-24"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium" htmlFor="goal-steps">
                {t("pursueGoal.fields.steps")}
              </label>
              <Textarea
                id="goal-steps"
                name="pursue_goal_steps"
                value={steps}
                onChange={(event) => setSteps(event.target.value)}
                className="min-h-28"
                autoComplete="off"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={saving}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={saving || !objective.trim()}>
                {saving && <IconLoader2 className="size-4 animate-spin" />}
                {t("pursueGoal.actions.start")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
