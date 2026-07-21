import type { AgentRun, AgentRunStatus, TaskGraphStep } from "@/api/agent-runs"

export type AgentRunStatusFilter = AgentRunStatus | "all"

export interface AgentRunsSearchState {
  q: string
  status: AgentRunStatusFilter
  run: string
  step: string
  page: number
}

const AGENT_RUN_STATUS_FILTERS = new Set<AgentRunStatusFilter>([
  "all",
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
])

function normalizeSearchString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeSearchPage(value: unknown): number {
  const page =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : 1

  return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
}

export function normalizeAgentRunsSearch(
  value: unknown,
): AgentRunsSearchState {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}
  const rawStatus = source.status
  const status =
    typeof rawStatus === "string" &&
    AGENT_RUN_STATUS_FILTERS.has(rawStatus as AgentRunStatusFilter)
      ? (rawStatus as AgentRunStatusFilter)
      : "all"

  return {
    q: normalizeSearchString(source.q),
    status,
    run: normalizeSearchString(source.run),
    step: normalizeSearchString(source.step),
    page: normalizeSearchPage(source.page),
  }
}

export const DEFAULT_RUN_STEPS = [
  "Capture objective and constraints",
  "Plan the execution path",
  "Run implementation or analysis",
  "Verify with evidence",
]

export interface RunSummary {
  totalSteps: number
  completedSteps: number
  failedSteps: number
  runningSteps: number
  evidenceCount: number
}

export interface RunDraftValidation {
  objective: string
  steps: string[]
  errors: {
    objective?: string
    steps?: string
  }
}

export function parseRunStepLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function validateRunDraft(
  objectiveValue: string,
  stepsValue: string,
): RunDraftValidation {
  const objective = objectiveValue.trim()
  const steps = parseRunStepLines(stepsValue)
  return {
    objective,
    steps,
    errors: {
      objective: objective ? undefined : "Objective is required.",
      steps: steps.length > 0 ? undefined : "At least one step is required.",
    },
  }
}

export function buildReplayRunPayload(run: AgentRun): {
  objective: string
  steps: string[]
} {
  return {
    objective: `Replay: ${run.objective}`.trim(),
    steps: run.steps.map((step) => step.title.trim()).filter(Boolean),
  }
}

export function summarizeRun(run: AgentRun): RunSummary {
  return run.steps.reduce<RunSummary>(
    (summary, step) => {
      summary.totalSteps += 1
      summary.evidenceCount += step.evidence.length
      if (step.status === "completed") summary.completedSteps += 1
      if (step.status === "failed") summary.failedSteps += 1
      if (step.status === "running") summary.runningSteps += 1
      return summary
    },
    {
      totalSteps: 0,
      completedSteps: 0,
      failedSteps: 0,
      runningSteps: 0,
      evidenceCount: 0,
    },
  )
}

export function filterAgentRuns(
  runs: AgentRun[],
  query: string,
  status: AgentRunStatusFilter,
): AgentRun[] {
  const normalizedQuery = query.trim().toLowerCase()
  return runs.filter((run) => {
    if (status !== "all" && run.status !== status) return false
    if (!normalizedQuery) return true
    return (
      run.objective.toLowerCase().includes(normalizedQuery) ||
      run.id.toLowerCase().includes(normalizedQuery) ||
      run.steps.some((step) =>
        [
          step.title,
          step.status,
          step.error?.message ?? "",
          ...step.evidence.map((evidence) => evidence.summary),
        ].some((value) => value.toLowerCase().includes(normalizedQuery)),
      )
    )
  })
}

export function resolveSelectedStep(
  run: AgentRun | null,
  currentStepId: string | null,
): TaskGraphStep | null {
  if (!run || run.steps.length === 0) return null
  return (
    run.steps.find((step) => step.id === currentStepId) ??
    run.steps.find((step) => step.status === "running") ??
    run.steps.find((step) => step.status === "failed") ??
    run.steps[0]
  )
}
