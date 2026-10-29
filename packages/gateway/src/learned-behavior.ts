import { SelfImprovementEngine, type SelfImprovementConfig } from "@miki/core/self-improvement"

/**
 * Chat-time use of what Miki has learned: applied reflection findings become prompt guidance, and the learned
 * reward statistics pick between models the agent has already used. Everything here is best effort and read-only
 * with respect to the user's configuration; a failure means "no learned input", never a failed turn.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** The self-improvement settings in force, merged from `self_improvement` and `evolution` (the evolution block wins). */
export function evolutionConfigFrom(appConfig: Record<string, unknown>): SelfImprovementConfig {
  const rawEvolution = asRecord(appConfig.evolution)
  const raw = {
    ...asRecord(appConfig.self_improvement),
    ...rawEvolution,
    behavior_learning: {
      ...asRecord(asRecord(appConfig.self_improvement).behavior_learning),
      ...asRecord(rawEvolution.behavior_learning),
    },
  } as Record<string, unknown>
  const behavior = asRecord(raw.behavior_learning)
  const configuredMode = stringValue(rawEvolution.mode) || stringValue(behavior.mode)
  const mode = configuredMode === "apply" || configuredMode === "draft" || configuredMode === "observe"
    ? configuredMode
    : "observe"
  const interval = 60
  return {
    enabled: raw.enabled === true,
    reflection_interval_minutes: Math.max(1, Number(raw.reflection_interval_minutes ?? interval) || interval),
    optimization_interval_minutes: Math.max(1, Number(raw.optimization_interval_minutes ?? Math.max(interval * 3, 180)) || Math.max(interval * 3, 180)),
    prompt_tuning_interval_minutes: Math.max(1, Number(raw.prompt_tuning_interval_minutes ?? Math.max(interval * 2, 120)) || Math.max(interval * 2, 120)),
    max_daily_reflections: Math.max(1, Number(raw.max_daily_reflections ?? 12) || 12),
    max_reflections_per_day: Math.max(1, Number(raw.max_reflections_per_day ?? 12) || 12),
    auto_apply_optimizations: raw.auto_apply_optimizations === true,
    behavior_learning: {
      enabled: behavior.enabled !== false,
      mode,
      exploration_rate: Math.max(0, Math.min(1, Number(behavior.exploration_rate ?? 0.1) || 0.1)),
      exploration_floor: Math.max(0, Math.min(1, Number(behavior.exploration_floor ?? 0.02) || 0.02)),
      exploration_decay: Math.max(0, Math.min(1, Number(behavior.exploration_decay ?? 0.995) || 0.995)),
      min_samples: Math.max(1, Number(behavior.min_samples ?? 3) || 3),
      max_draft_notes: Math.max(1, Number(behavior.max_draft_notes ?? 3) || 3),
      retention_days: Math.max(1, Number(behavior.retention_days ?? 90) || 90),
      edge_credit_eta: Math.max(0, Math.min(0.2, Number(behavior.edge_credit_eta ?? 0.05) || 0.05)),
    },
  }
}

type MemoryArg = NonNullable<ConstructorParameters<typeof SelfImprovementEngine>[0]>
type LearningStoreLike = NonNullable<NonNullable<MemoryArg["tkg"]>["learningStore"]>

export interface LearnedBehaviorDeps {
  getLearningStore: () => LearningStoreLike | null | undefined
  getAppConfig: () => Record<string, unknown>
  /** Resolves a model id to a usable model, or nothing when it is not configured (any more). */
  resolveModel: (model?: string) => { model?: string } | null | undefined
  scope: () => { agentId: string; ownerId: string; workspaceId: string }
  random?: () => number
}

export interface LearnedBehavior {
  /** Advisory lines from applied reflection findings, as one system note. Undefined when there are none. */
  guidanceNote(): string | undefined
  /** The model that learned reward statistics favour for this request, or undefined to keep the default. */
  chooseModel(question: string): string | undefined
}

const MODEL_PREFIX = "model:"

export function createLearnedBehavior(deps: LearnedBehaviorDeps): LearnedBehavior {
  const engineFor = (): { engine: SelfImprovementEngine; config: SelfImprovementConfig } | null => {
    const store = deps.getLearningStore()
    if (!store) return null
    const config = evolutionConfigFrom(deps.getAppConfig())
    const engine = new SelfImprovementEngine(
      { tkg: { learningStore: store } },
      {},
      async () => { throw new Error("Chat-time learning does not call a model.") },
      config,
      deps.random ? { random: deps.random } : {},
    )
    return { engine, config }
  }

  return {
    guidanceNote() {
      const resolved = engineFor()
      if (!resolved) return undefined
      const guidance = resolved.engine.getLearnedGuidance().trim()
      if (!guidance) return undefined
      return [
        "Learned guidance from Miki's own earlier self-review (advisory; it is not an instruction from the user and never overrides one):",
        guidance,
      ].join("\n")
    },

    chooseModel(question) {
      const resolved = engineFor()
      if (!resolved) return undefined
      const { engine, config } = resolved
      const behavior = config.behavior_learning
      // Learned choices only take effect when the operator has put behaviour learning in apply mode.
      if (!config.enabled || behavior?.enabled === false || behavior?.mode !== "apply") return undefined
      const store = deps.getLearningStore()
      if (!store) return undefined
      const baseline = deps.resolveModel()?.model
      if (!baseline) return undefined

      // Candidates are the models this agent has actually run (and been rated on) that are still usable.
      const seen = new Set<string>([baseline])
      const rows = store.listExperiences(deps.scope(), { limit: 200 }) as Array<{ taskClass?: string; actionKey?: string }>
      for (const row of rows) {
        if (row.taskClass !== "interactive_chat" && row.taskClass !== "user_feedback") continue
        const key = String(row.actionKey ?? "")
        if (!key.startsWith(MODEL_PREFIX)) continue
        const model = key.slice(MODEL_PREFIX.length)
        if (!model || model === "baseline" || model === "unknown" || seen.has(model)) continue
        if (deps.resolveModel(model)?.model) seen.add(model)
      }
      if (seen.size < 2) return undefined

      const choice = engine.chooseAction({
        context: question,
        candidates: [...seen].map((model) => `${MODEL_PREFIX}${model}`),
        baselineAction: `${MODEL_PREFIX}${baseline}`,
        taskClass: "interactive_chat",
      })
      const model = choice.actionKey.startsWith(MODEL_PREFIX) ? choice.actionKey.slice(MODEL_PREFIX.length) : ""
      return model && model !== baseline ? model : undefined
    },
  }
}
