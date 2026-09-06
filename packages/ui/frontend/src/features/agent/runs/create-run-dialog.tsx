import { type FormEvent, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import type { CreateAgentRunPayload } from "@/api/agent-runs"
import { Button } from "@/shared/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import { Textarea } from "@/shared/ui/textarea"

import { validateRunDraft } from "./runs-page-model"

interface CreateRunDialogProps {
  open: boolean
  isCreating: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (payload: CreateAgentRunPayload) => void
}

const INITIAL_OBJECTIVE = ""

export function CreateRunDialog({
  open,
  isCreating,
  onOpenChange,
  onCreate,
}: CreateRunDialogProps) {
  const { t } = useTranslation()
  const defaultStepsText = t("agentRuns.create.defaultSteps")
  const [objective, setObjective] = useState(INITIAL_OBJECTIVE)
  const [stepsText, setStepsText] = useState(defaultStepsText)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    if (!open) {
      setObjective(INITIAL_OBJECTIVE)
      setStepsText(defaultStepsText)
      setSubmitted(false)
    }
  }, [defaultStepsText, open])

  const validation = validateRunDraft(objective, stepsText)
  const objectiveError =
    submitted && validation.errors.objective
      ? t("agentRuns.create.objectiveRequired")
      : undefined
  const stepsError =
    submitted && validation.errors.steps
      ? t("agentRuns.create.stepsRequired")
      : undefined

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitted(true)
    if (validation.errors.objective || validation.errors.steps) return
    onCreate({
      objective: validation.objective,
      steps: validation.steps,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{t("agentRuns.create.title")}</DialogTitle>
            <DialogDescription>
              {t("agentRuns.create.description")}
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="gap-5">
            <Field data-invalid={Boolean(objectiveError)}>
              <FieldLabel htmlFor="agent-run-objective">
                {t("agentRuns.create.objectiveLabel")}
              </FieldLabel>
              <Input
                id="agent-run-objective"
                name="agent_run_objective"
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder={t("agentRuns.create.objectivePlaceholder")}
                aria-invalid={Boolean(objectiveError)}
                autoComplete="off"
                autoFocus
              />
              <FieldDescription>
                {t("agentRuns.create.objectiveHint")}
              </FieldDescription>
              <FieldError>{objectiveError}</FieldError>
            </Field>

            <Field data-invalid={Boolean(stepsError)}>
              <FieldLabel htmlFor="agent-run-steps">
                {t("agentRuns.create.stepsLabel")}
              </FieldLabel>
              <Textarea
                id="agent-run-steps"
                name="agent_run_steps"
                value={stepsText}
                onChange={(event) => setStepsText(event.target.value)}
                className="min-h-36 resize-y font-mono text-sm"
                aria-invalid={Boolean(stepsError)}
                autoComplete="off"
              />
              <FieldDescription>
                {t("agentRuns.create.stepsHint")}
              </FieldDescription>
              <FieldError>{stepsError}</FieldError>
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isCreating}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={isCreating}>
              {t("agentRuns.actions.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
