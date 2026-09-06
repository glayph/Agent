import { createHash } from "node:crypto";

export type LLMCallFn = (
  messages: Array<{ role: string; content: string }>,
) => Promise<{ choices: Array<{ message: { content: string | null } }> }>;

type Scope = {
  agentId?: string;
  ownerId?: string;
  workspaceId?: string;
  scopeKey?: string;
};

type LearningExperience = {
  id: string;
  actionKey: string;
  actionPayload: Record<string, unknown>;
  contextHash: string;
  contextSummary: string;
  outcome: string;
  reward: number;
  rewardComponents: Record<string, number>;
  policyVersion: number;
  modelId: string | null;
  createdAt: string;
  [key: string]: unknown;
};

type LearningStore = {
  normalizeScope(scope?: Scope): Scope & { scopeKey: string };
  recordExperience(input: Record<string, unknown>): {
    stored: boolean;
    duplicate: boolean;
    row: LearningExperience;
  };
  listExperiences(
    scope?: Scope,
    options?: Record<string, unknown>,
  ): LearningExperience[];
  getExperienceStats(
    scope?: Scope,
    options?: Record<string, unknown>,
  ): Record<string, unknown>;
  readPolicyState(scope?: Scope): Record<string, unknown>;
  upsertPolicyState(
    scope?: Scope,
    state?: Record<string, unknown>,
  ): Record<string, unknown>;
  startCycle(
    scope: Scope | undefined,
    cycleType: string,
    metadata?: Record<string, unknown>,
  ): Record<string, unknown>;
  finishCycle(
    cycleId: string,
    result?: Record<string, unknown>,
  ): Record<string, unknown>;
  countCyclesSince(
    scope: Scope | undefined,
    cycleType: string,
    since?: string,
  ): number;
  lastCycle(
    scope: Scope | undefined,
    cycleType: string,
  ): Record<string, unknown> | null;
  createProposal(
    input?: Record<string, unknown>,
  ): Record<string, unknown> | null;
  listProposals(
    scope: Scope | undefined,
    options?: Record<string, unknown>,
  ): Array<Record<string, unknown> | null>;
};

type MemoryIntegration = {
  tkg?: { learningStore?: LearningStore | null };
};

export interface SelfImprovementConfig {
  enabled?: boolean;
  reflection_interval_minutes?: number;
  optimization_interval_minutes?: number;
  prompt_tuning_interval_minutes?: number;
  max_daily_reflections?: number;
  max_reflections_per_day?: number;
  auto_apply_optimizations?: boolean;
  drift_threshold?: number;
  guardrails?: {
    enabled?: boolean;
    max_prompt_drift_percent?: number;
  };
  behavior_learning?: {
    enabled?: boolean;
    mode?: "observe" | "draft" | "apply";
    exploration_rate?: number;
    min_samples?: number;
    max_draft_notes?: number;
  };
}

interface CircuitBreaker {
  tripped: boolean;
  errorRate: number;
  totalCalls: number;
  recentErrors: string[];
}

type CycleType = "reflection" | "optimization" | "prompt_tuning";

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}

function unit(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, 0, 1) : fallback;
}

function signed(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, -1, 1) : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function contextHash(value: unknown): string {
  return createHash("sha256")
    .update(
      String(value ?? "")
        .trim()
        .toLowerCase(),
    )
    .digest("hex");
}

function modeOf(config: SelfImprovementConfig): "observe" | "draft" | "apply" {
  const mode = config.behavior_learning?.mode;
  return mode === "apply" || mode === "draft" ? mode : "observe";
}

export function calculateReward(input: {
  completionQuality?: unknown;
  taskSuccess?: unknown;
  userFeedback?: unknown;
  verificationSuccess?: unknown;
  latencyScore?: unknown;
  retryCount?: unknown;
  safetyViolation?: unknown;
  outcome?: string;
}): { reward: number; components: Record<string, number> } {
  const outcomeSuccess = input.outcome === "success" ? 1 : 0;
  const taskSuccess =
    input.taskSuccess == null ? outcomeSuccess : unit(input.taskSuccess);
  const retryCount = Math.max(0, Number(input.retryCount || 0) || 0);
  const retryPenalty = clamp(retryCount / 3, 0, 1);
  const safetyPenalty = unit(input.safetyViolation);
  const components = {
    completionQuality: unit(input.completionQuality, outcomeSuccess),
    taskSuccess,
    userFeedback: signed(input.userFeedback),
    verificationSuccess: unit(input.verificationSuccess, outcomeSuccess),
    latencyScore: unit(input.latencyScore, 0.5),
    retryPenalty,
    safetyViolationPenalty: safetyPenalty,
  };
  const reward = clamp(
    0.35 * components.completionQuality +
      0.25 * components.taskSuccess +
      0.15 * components.userFeedback +
      0.1 * components.verificationSuccess +
      0.1 * components.latencyScore -
      0.15 * components.retryPenalty -
      0.1 * components.safetyViolationPenalty,
    -1,
    1,
  );
  return { reward, components };
}

export class SelfImprovementEngine {
  private enabled: boolean;
  private memory: MemoryIntegration | null;
  private readonly config: SelfImprovementConfig;
  private readonly llmCallFn: LLMCallFn;
  private readonly scope: Scope;
  private cycleRunning = false;
  private readonly recentErrors: string[] = [];

  readonly _circuitBreaker: CircuitBreaker = {
    tripped: false,
    errorRate: 0,
    totalCalls: 0,
    recentErrors: this.recentErrors,
  };

  constructor(
    memory: MemoryIntegration | null,
    _paths: unknown,
    llmCallFn: LLMCallFn,
    config: SelfImprovementConfig = {},
  ) {
    this.memory = memory;
    this.config = config;
    this.enabled = config.enabled ?? false;
    this.llmCallFn = llmCallFn;
    this.scope = {
      agentId: process.env.MIKI_AGENT_ID || "miki",
      ownerId: process.env.MIKI_OWNER_ID || "default-owner",
      workspaceId: process.env.MIKI_WORKSPACE_ID || "default-workspace",
    };
    const store = this.store();
    if (store) {
      const persisted = store.readPolicyState(this.scope);
      // Runtime config is the source of truth for the operational mode; keep
      // the durable state aligned without changing learned action statistics.
      if (persisted.mode !== modeOf(config)) {
        store.upsertPolicyState(this.scope, {
          ...persisted,
          mode: modeOf(config),
        });
      }
    }
  }

  private store(): LearningStore | null {
    return this.memory?.tkg?.learningStore ?? null;
  }

  private setCallResult(success: boolean, error?: unknown): void {
    this._circuitBreaker.totalCalls += 1;
    if (!success) {
      this.recentErrors.unshift(safeError(error));
      this.recentErrors.splice(5);
    }
    const errors = this.recentErrors.length;
    this._circuitBreaker.errorRate =
      errors / Math.max(1, this._circuitBreaker.totalCalls);
    if (errors >= 3 && this._circuitBreaker.totalCalls >= 3) {
      this._circuitBreaker.tripped = true;
    }
  }

  private intervalMinutes(type: CycleType): number {
    const key =
      `${type === "prompt_tuning" ? "prompt_tuning" : type}_interval_minutes` as keyof SelfImprovementConfig;
    return positiveInt(
      this.config[key],
      type === "reflection" ? 60 : type === "optimization" ? 180 : 120,
    );
  }

  private cycleDue(type: CycleType): boolean {
    if (!this.enabled || this._circuitBreaker.tripped || this.cycleRunning)
      return false;
    const store = this.store();
    if (!store) return false;
    const last = store.lastCycle(this.scope, type);
    if (!last) return true;
    const completedAt = String(last.completedAt || last.startedAt || "");
    const timestamp = Date.parse(completedAt);
    if (!Number.isFinite(timestamp)) return true;
    return Date.now() - timestamp >= this.intervalMinutes(type) * 60 * 1000;
  }

  _reflectionDue(): boolean {
    return this.cycleDue("reflection");
  }

  _tuningDue(): boolean {
    return this.cycleDue("prompt_tuning");
  }

  _optimizationDue(): boolean {
    return this.cycleDue("optimization");
  }

  private reflectionLimitReached(): boolean {
    const store = this.store();
    if (!store) return true;
    const limit = positiveInt(
      this.config.max_reflections_per_day ?? this.config.max_daily_reflections,
      12,
    );
    return (
      store.countCyclesSince(this.scope, "reflection", isoDaysAgo(1)) >= limit
    );
  }

  private aggregateActionStats(
    experiences: LearningExperience[],
  ): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};
    for (const experience of experiences) {
      const action = experience.actionKey || "baseline";
      const current = result[action] || {
        count: 0,
        rewardSum: 0,
        averageReward: 0,
      };
      current.count += 1;
      current.rewardSum += Number(experience.reward) || 0;
      current.averageReward = current.rewardSum / current.count;
      result[action] = current;
    }
    return result;
  }

  private bestAction(
    stats: Record<string, Record<string, number>>,
  ): string | null {
    const minSamples = positiveInt(
      this.config.behavior_learning?.min_samples,
      3,
    );
    return (
      Object.entries(stats)
        .filter(([, value]) => value.count >= minSamples)
        .sort(
          ([, a], [, b]) =>
            b.averageReward - a.averageReward || b.count - a.count,
        )
        .map(([action]) => action)[0] ?? null
    );
  }

  chooseAction(input: {
    context?: string;
    candidates?: string[];
    baselineAction?: string;
  }): {
    actionKey: string;
    explored: boolean;
    policyVersion: number;
    reason: string;
  } {
    const store = this.store();
    const policy = store?.readPolicyState(this.scope) ?? {
      policyVersion: 1,
      mode: "observe",
      actionStats: {},
      totalDecisions: 0,
    };
    const candidates = (
      input.candidates || [input.baselineAction || "baseline"]
    ).filter(Boolean);
    const stats = (policy.actionStats || {}) as Record<
      string,
      Record<string, number>
    >;
    const learned = candidates
      .filter(
        (action) =>
          Number(stats[action]?.count || 0) >=
          positiveInt(this.config.behavior_learning?.min_samples, 3),
      )
      .sort(
        (a, b) =>
          Number(stats[b]?.averageReward || 0) -
          Number(stats[a]?.averageReward || 0),
      )[0];
    const explorationRate = unit(
      this.config.behavior_learning?.exploration_rate,
      0.1,
    );
    const shouldExplore =
      this.config.behavior_learning?.enabled !== false &&
      Math.random() < explorationRate;
    const actionKey = shouldExplore
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : learned || input.baselineAction || candidates[0] || "baseline";
    return {
      actionKey,
      explored: shouldExplore,
      policyVersion: Number(policy.policyVersion || 1),
      reason: shouldExplore
        ? "exploration"
        : learned
          ? "best_observed_reward"
          : "baseline_insufficient_samples",
    };
  }

  recordExperience(input: {
    scope?: Scope;
    runId?: string;
    sessionId?: string;
    taskId?: string;
    taskClass?: string;
    context?: string;
    contextHash?: string;
    actionKey?: string;
    actionPayload?: Record<string, unknown>;
    outcome?: string;
    reward?: number;
    rewardInput?: Parameters<typeof calculateReward>[0];
    modelId?: string;
    policyVersion?: number;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }): {
    stored: boolean;
    duplicate: boolean;
    reward: number;
    row: LearningExperience;
  } | null {
    const store = this.store();
    if (!store) return null;
    const rewardResult = input.rewardInput
      ? calculateReward(input.rewardInput)
      : { reward: clamp(Number(input.reward || 0), -1, 1), components: {} };
    const result = store.recordExperience({
      scope: input.scope || this.scope,
      runId: input.runId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      taskClass: input.taskClass,
      contextSummary: input.context || "",
      contextHash: input.contextHash || contextHash(input.context || ""),
      actionKey: input.actionKey || "baseline",
      actionPayload: input.actionPayload || {},
      outcome: input.outcome || "unknown",
      reward: rewardResult.reward,
      rewardComponents: rewardResult.components,
      modelId: input.modelId,
      policyVersion: input.policyVersion,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata || {},
    });

    // Update only after a newly stored experience. Duplicate retries must not
    // bias the bandit statistics or advance its decision count.
    if (result.stored && this.config.behavior_learning?.enabled !== false) {
      const policy = store.readPolicyState(input.scope || this.scope);
      const actionStats = {
        ...((policy.actionStats || {}) as Record<
          string,
          Record<string, number>
        >),
      };
      const actionKey = input.actionKey || "baseline";
      const previous = actionStats[actionKey] || {
        count: 0,
        rewardSum: 0,
        averageReward: 0,
      };
      const count = Number(previous.count || 0) + 1;
      const rewardSum = Number(previous.rewardSum || 0) + rewardResult.reward;
      actionStats[actionKey] = {
        count,
        rewardSum,
        averageReward: rewardSum / count,
      };
      const totalDecisions = Number(policy.totalDecisions || 0) + 1;
      const averageReward =
        (Number(policy.averageReward || 0) * (totalDecisions - 1) +
          rewardResult.reward) /
        totalDecisions;
      store.upsertPolicyState(input.scope || this.scope, {
        ...policy,
        actionStats,
        totalDecisions,
        averageReward,
      });
    }
    return { ...result, reward: rewardResult.reward };
  }

  private async callForAnalysis(
    experiences: LearningExperience[],
  ): Promise<string | null> {
    if (!this.llmCallFn || experiences.length === 0) return null;
    try {
      const response = await this.llmCallFn([
        {
          role: "system",
          content:
            "Summarize agent learning evidence in JSON with keys: finding, confidence, recommendation. Do not propose code, credentials, shell commands, or external side effects.",
        },
        {
          role: "user",
          content: JSON.stringify(
            experiences.slice(0, 20).map((item) => ({
              action: item.actionKey,
              outcome: item.outcome,
              reward: item.reward,
              taskClass: item.taskClass,
            })),
          ),
        },
      ]);
      return response.choices?.[0]?.message?.content?.slice(0, 2000) || null;
    } catch (error) {
      this.setCallResult(false, error);
      return null;
    }
  }

  private async runCycle(
    type: CycleType,
    force = false,
  ): Promise<Record<string, unknown>> {
    const store = this.store();
    if (!this.enabled)
      return { status: "disabled", cycleType: type, cycleId: null };
    if (!store)
      return {
        status: "degraded",
        cycleType: type,
        cycleId: null,
        degradedReason: "durable_memory_unavailable",
      };
    if (this._circuitBreaker.tripped)
      return {
        status: "degraded",
        cycleType: type,
        cycleId: null,
        degradedReason: "circuit_breaker_tripped",
      };
    if (this.cycleRunning)
      return {
        status: "skipped",
        cycleType: type,
        cycleId: null,
        reason: "cycle_already_running",
      };
    if (!force && !this.cycleDue(type))
      return {
        status: "skipped",
        cycleType: type,
        cycleId: null,
        reason: "not_due",
      };
    if (type === "reflection" && this.reflectionLimitReached())
      return {
        status: "skipped",
        cycleType: type,
        cycleId: null,
        reason: "daily_reflection_limit",
      };

    this.cycleRunning = true;
    const cycle = store.startCycle(this.scope, type, {
      mode: modeOf(this.config),
    });
    try {
      const experiences = store.listExperiences(this.scope, {
        limit: 100,
        since: isoDaysAgo(7),
      });
      if (experiences.length === 0) {
        const finished = store.finishCycle(String(cycle.id), {
          status: "skipped",
          inputCount: 0,
          outputCount: 0,
          metadata: { reason: "no_experiences" },
        });
        this.setCallResult(true);
        return {
          ...finished,
          cycleType: type,
          inputCount: 0,
          outputCount: 0,
          reason: "no_experiences",
        };
      }
      const stats = store.getExperienceStats(this.scope, {
        since: isoDaysAgo(7),
      });
      const maxDraftNotes = positiveInt(
        this.config.behavior_learning?.max_draft_notes,
        3,
      );
      if (
        (type === "reflection" || type === "prompt_tuning") &&
        store
          .listProposals(this.scope, {
            status: "draft",
            limit: maxDraftNotes + 1,
          })
          .filter(Boolean).length >= maxDraftNotes
      ) {
        const finished = store.finishCycle(String(cycle.id), {
          status: "skipped",
          inputCount: experiences.length,
          outputCount: 0,
          metadata: { reason: "draft_limit" },
        });
        this.setCallResult(true);
        return {
          ...finished,
          cycleType: type,
          inputCount: experiences.length,
          outputCount: 0,
          reason: "draft_limit",
        };
      }
      const actionStats = this.aggregateActionStats(experiences);
      const bestAction = this.bestAction(actionStats);
      const analysis =
        type === "reflection" ? await this.callForAnalysis(experiences) : null;
      let outputCount = 0;
      let proposal: Record<string, unknown> | null = null;

      if (type === "optimization") {
        const policy = store.readPolicyState(this.scope);
        const nextVersion = Number(policy.policyVersion || 1) + 1;
        store.upsertPolicyState(this.scope, {
          policyVersion: nextVersion,
          mode: modeOf(this.config),
          actionStats,
          totalDecisions: experiences.length,
          averageReward: Number(stats.averageReward || 0),
          baselineAction: bestAction || policy.baselineAction || "baseline",
          metadata: { lastOptimizationCycle: cycle.id },
        });
        proposal = store.createProposal({
          scope: this.scope,
          kind: "policy",
          basePolicyVersion: nextVersion,
          payload: {
            recommendedAction: bestAction || "baseline",
            actionStats,
            mode: modeOf(this.config),
          },
          evidenceIds: experiences.slice(0, 20).map((item) => item.id),
          status:
            modeOf(this.config) === "apply" &&
            this.config.auto_apply_optimizations === true
              ? "approved"
              : "draft",
          metadata: { cycleId: cycle.id },
        });
        outputCount = 1;
      } else if (type === "reflection" || type === "prompt_tuning") {
        proposal = store.createProposal({
          scope: this.scope,
          kind: type === "reflection" ? "reflection" : "prompt_tuning",
          basePolicyVersion: Number(
            store.readPolicyState(this.scope).policyVersion || 1,
          ),
          payload: {
            finding:
              type === "reflection"
                ? analysis ||
                  "Deterministic reward and outcome summary generated."
                : "Prompt tuning requires a draft review before any application.",
            bestAction,
            actionStats,
            evidenceSummary: stats,
          },
          evidenceIds: experiences.slice(0, 20).map((item) => item.id),
          status: "draft",
          metadata: { cycleId: cycle.id },
        });
        outputCount = proposal ? 1 : 0;
      }

      const finished = store.finishCycle(String(cycle.id), {
        status: this._circuitBreaker.tripped ? "degraded" : "completed",
        inputCount: experiences.length,
        outputCount,
        metadata: {
          proposalId: proposal?.id || null,
          policyVersion: store.readPolicyState(this.scope).policyVersion,
        },
      });
      this.setCallResult(true);
      return {
        ...finished,
        cycleType: type,
        inputCount: experiences.length,
        outputCount,
        proposal,
        policyVersion: store.readPolicyState(this.scope).policyVersion,
      };
    } catch (error) {
      this.setCallResult(false, error);
      const finished = store.finishCycle(String(cycle.id), {
        status: "failed",
        error: safeError(error),
      });
      return { ...finished, cycleType: type, error: safeError(error) };
    } finally {
      this.cycleRunning = false;
    }
  }

  getAccumulatedTunings(): string[] {
    const store = this.store();
    if (!store) return [];
    return store
      .listProposals(this.scope, { status: "draft" })
      .filter(Boolean)
      .map((item) => JSON.stringify(item));
  }

  getLearningStats(): Record<string, unknown> {
    const store = this.store();
    if (!store)
      return {
        totalSuggestions: 0,
        appliedCount: 0,
        rewards: [],
        degradedReason: "durable_memory_unavailable",
      };
    const stats = store.getExperienceStats(this.scope, {
      since: isoDaysAgo(30),
    });
    const applied = store
      .listProposals(this.scope, { status: "applied", limit: 200 })
      .filter(Boolean).length;
    return {
      totalSuggestions: Number(stats.total || 0),
      appliedCount: applied,
      rewards: [Number(stats.averageReward || 0)],
      actions: stats.actions || [],
      outcomes: stats.outcomes || [],
    };
  }

  getStatus(): Record<string, unknown> {
    const store = this.store();
    const policy = store?.readPolicyState(this.scope);
    const learning = this.getLearningStats();
    const mode = modeOf(this.config);
    return {
      enabled: this.enabled,
      degraded: !store,
      degradedReason: store ? null : "durable_memory_unavailable",
      reflectionDue: this._reflectionDue(),
      tuningDue: this._tuningDue(),
      optimizationDue: this._optimizationDue(),
      reflectionsToday:
        store?.countCyclesSince(this.scope, "reflection", isoDaysAgo(1)) || 0,
      accumulatedTunings:
        store
          ?.listProposals(this.scope, { status: "draft", limit: 100 })
          .filter(Boolean).length || 0,
      circuitBreaker: {
        ...this._circuitBreaker,
        recentErrors: [...this.recentErrors],
      },
      learning,
      behaviorLearning: {
        enabled:
          this.config.behavior_learning?.enabled !== false && Boolean(store),
        mode,
        decisions: Number(policy?.totalDecisions || 0),
        averageReward: Number(policy?.averageReward || 0),
        bestActions: policy?.baselineAction ? [policy.baselineAction] : [],
        policyVersion: Number(policy?.policyVersion || 1),
        explorationRate: unit(
          this.config.behavior_learning?.exploration_rate,
          0.1,
        ),
        minSamples: positiveInt(this.config.behavior_learning?.min_samples, 3),
      },
      latestCycles: {
        reflection: store?.lastCycle(this.scope, "reflection") || null,
        promptTuning: store?.lastCycle(this.scope, "prompt_tuning") || null,
        optimization: store?.lastCycle(this.scope, "optimization") || null,
      },
    };
  }

  async runReflectionCycle(
    options: { force?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    return this.runCycle("reflection", options.force === true);
  }

  async runOptimizationCycle(
    options: { force?: boolean; apply?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    if (options.apply === true) {
      if (modeOf(this.config) !== "apply") {
        return {
          status: "rejected",
          cycleType: "optimization",
          cycleId: null,
          reason: "apply_mode_required",
        };
      }
      return {
        status: "rejected",
        cycleType: "optimization",
        cycleId: null,
        reason: "owner_approval_required",
      };
    }
    return this.runCycle("optimization", options.force === true);
  }

  async runPromptTuningCycle(
    options: { force?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    return this.runCycle("prompt_tuning", options.force === true);
  }
}
