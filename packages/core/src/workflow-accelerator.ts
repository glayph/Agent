import type { AgentRouteDecision } from "./agent-router.js";
import type { AgentTaskProfile } from "./task-profile.js";

export type WorkflowAccelerationMode = "turbo" | "balanced" | "safe";

export interface WorkflowAccelerationPlan {
  mode: WorkflowAccelerationMode;
  speedPriority: boolean;
  speedClass: AgentTaskProfile["speedClass"];
  expectedLatency: string;
  verificationDepth: AgentTaskProfile["verificationDepth"];
  maxParallelToolCalls: number;
  contextStrategy: string;
  executionStrategy: string;
  verificationStrategy: string;
  rules: string[];
}

export type WorkflowDecisionPatternId =
  | "turbo_implementation"
  | "turbo_triage"
  | "balanced_architecture"
  | "balanced_verification"
  | "safe_general";

export interface WorkflowDecisionPattern {
  id: WorkflowDecisionPatternId;
  objective: string;
  speedClass: AgentTaskProfile["speedClass"];
  expectedLatency: string;
  verificationDepth: AgentTaskProfile["verificationDepth"];
  firstPassActions: string[];
  contextBudget: {
    maxInitialFiles: number;
    maxInitialSearches: number;
    preferCache: boolean;
  };
  parallelism: {
    maxParallelToolCalls: number;
    safeReadParallelism: boolean;
    serializeWrites: boolean;
  };
  stopConditions: string[];
  escalationRules: string[];
}

interface WorkflowAccelerationOptions {
  maxParallelToolCalls?: number;
}

function boundedParallel(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : 3;
  return Math.max(1, Math.min(16, Math.floor(raw)));
}

export function buildWorkflowAccelerationPlan(
  profile: AgentTaskProfile,
  decision?: AgentRouteDecision,
  options: WorkflowAccelerationOptions = {},
): WorkflowAccelerationPlan {
  const speedPriority = profile.signals.includes("speed_priority");
  const selectedAgent = decision?.selected.id || "miki";
  const baseParallel = boundedParallel(options.maxParallelToolCalls);
  const mode: WorkflowAccelerationMode =
    profile.speedClass === "heavy"
      ? "balanced"
      : speedPriority
        ? "turbo"
        : profile.complexity === "complex"
          ? "balanced"
          : "turbo";
  const maxParallelToolCalls =
    mode === "turbo"
      ? Math.max(baseParallel, speedPriority ? 6 : 4)
      : baseParallel;

  return {
    mode,
    speedPriority,
    speedClass: profile.speedClass,
    expectedLatency: profile.expectedLatency,
    verificationDepth: profile.verificationDepth,
    maxParallelToolCalls,
    contextStrategy:
      mode === "turbo"
        ? "Use cached memory/index context first; avoid broad discovery unless the first pass fails."
        : "Gather enough context for correctness, then prune stale or low-signal branches.",
    executionStrategy:
      mode === "turbo"
        ? "Run independent read-only checks in parallel, serialize writes, and keep the critical path short."
        : "Batch related reads, preserve explicit checkpoints, and route work by task evidence.",
    verificationStrategy:
      mode === "turbo"
        ? "Use the narrowest high-signal verification first; expand only on failure or risk."
        : "Verify each changed surface with targeted commands or runtime probes.",
    rules: [
      `selected_agent:${selectedAgent}`,
      `complexity:${profile.complexity}`,
      `parallel_cap:${maxParallelToolCalls}`,
      mode === "turbo"
        ? "fail_fast_optional_branches"
        : "checkpoint_each_phase",
      "parallelize_safe_reads",
      "serialize_workspace_writes",
      "verify_before_final",
    ],
  };
}

export function buildWorkflowDecisionPattern(
  profile: AgentTaskProfile,
  decision?: AgentRouteDecision,
  plan: WorkflowAccelerationPlan = buildWorkflowAccelerationPlan(
    profile,
    decision,
  ),
): WorkflowDecisionPattern {
  const selectedAgent = decision?.selected.id || "miki";
  const speedPriority = plan.speedPriority;
  const verificationNeeded = profile.signals.includes("verification_needed");
  const implementationIntent = profile.signals.includes(
    "implementation_intent",
  );
  const architectureIntent =
    selectedAgent === "planner" || profile.signals.includes("complexity_terms");

  if (speedPriority && implementationIntent && profile.speedClass !== "heavy") {
    return {
      id: "turbo_implementation",
      objective:
        "Ship the smallest correct implementation slice quickly, with targeted verification before reporting.",
      speedClass: profile.speedClass,
      expectedLatency: profile.expectedLatency,
      verificationDepth: profile.verificationDepth,
      firstPassActions: [
        "use_system_index_or_rg_before_broad_reads",
        "parallel_read_relevant_files",
        "patch_smallest_safe_surface",
        "run_focused_test_or_build",
      ],
      contextBudget: {
        maxInitialFiles: 8,
        maxInitialSearches: 4,
        preferCache: true,
      },
      parallelism: {
        maxParallelToolCalls: plan.maxParallelToolCalls,
        safeReadParallelism: true,
        serializeWrites: true,
      },
      stopConditions: [
        "targeted_verification_passed",
        "blocking_missing_dependency_identified",
      ],
      escalationRules: [
        "expand_context_only_after_failed_verification",
        "switch_to_balanced_if_multiple_subsystems_conflict",
      ],
    };
  }

  if (speedPriority && profile.speedClass !== "heavy") {
    return {
      id: "turbo_triage",
      objective:
        "Classify the task fast, take the highest-confidence path, and avoid optional exploration.",
      speedClass: profile.speedClass,
      expectedLatency: profile.expectedLatency,
      verificationDepth: profile.verificationDepth,
      firstPassActions: [
        "classify_goal_and_risk",
        "use_cached_context_first",
        "parallelize_safe_reads",
        "answer_or_execute_minimal_next_step",
      ],
      contextBudget: {
        maxInitialFiles: 5,
        maxInitialSearches: 3,
        preferCache: true,
      },
      parallelism: {
        maxParallelToolCalls: plan.maxParallelToolCalls,
        safeReadParallelism: true,
        serializeWrites: true,
      },
      stopConditions: [
        "high_confidence_answer_or_patch_ready",
        "risk_requires_deeper_verification",
      ],
      escalationRules: [
        "ask_for_more_context_only_when_execution_would_be_unsafe",
        "run_narrow_verification_before_final_for_state_changes",
      ],
    };
  }

  if (architectureIntent) {
    return {
      id: "balanced_architecture",
      objective:
        "Preserve system architecture while progressing through explicit milestones and evidence gates.",
      speedClass: profile.speedClass,
      expectedLatency: profile.expectedLatency,
      verificationDepth: profile.verificationDepth,
      firstPassActions: [
        "map_existing_architecture",
        "identify_owned_change_surface",
        "sequence_changes_by_dependency",
        "verify_each_changed_boundary",
      ],
      contextBudget: {
        maxInitialFiles: 12,
        maxInitialSearches: 6,
        preferCache: true,
      },
      parallelism: {
        maxParallelToolCalls: plan.maxParallelToolCalls,
        safeReadParallelism: true,
        serializeWrites: true,
      },
      stopConditions: [
        "milestone_verified",
        "architecture_gap_requires_next_slice",
      ],
      escalationRules: [
        "split_work_when_change_surface_crosses_three_subsystems",
        "prefer_adapter_or_contract_boundary_over_inline_coupling",
      ],
    };
  }

  if (verificationNeeded) {
    return {
      id: "balanced_verification",
      objective:
        "Collect enough evidence to prove the changed or questioned behavior without broad unrelated work.",
      speedClass: profile.speedClass,
      expectedLatency: profile.expectedLatency,
      verificationDepth: profile.verificationDepth,
      firstPassActions: [
        "identify_claim_under_test",
        "run_targeted_command_or_probe",
        "inspect_failure_if_any",
        "report_evidence_and_residual_risk",
      ],
      contextBudget: {
        maxInitialFiles: 6,
        maxInitialSearches: 4,
        preferCache: true,
      },
      parallelism: {
        maxParallelToolCalls: plan.maxParallelToolCalls,
        safeReadParallelism: true,
        serializeWrites: true,
      },
      stopConditions: ["evidence_confirms_claim", "evidence_contradicts_claim"],
      escalationRules: [
        "expand_to_integration_smoke_when_unit_evidence_is_indirect",
        "do_not_report_success_without_command_or_runtime_evidence",
      ],
    };
  }

  return {
    id: "safe_general",
    objective:
      "Handle the request directly with minimal overhead while preserving safety and workspace boundaries.",
    speedClass: profile.speedClass,
    expectedLatency: profile.expectedLatency,
    verificationDepth: profile.verificationDepth,
    firstPassActions: [
      "answer_directly_if_no_state_change",
      "inspect_minimal_context_if_needed",
      "verify_when_files_or_runtime_change",
    ],
    contextBudget: {
      maxInitialFiles: 4,
      maxInitialSearches: 2,
      preferCache: true,
    },
    parallelism: {
      maxParallelToolCalls: Math.min(plan.maxParallelToolCalls, 4),
      safeReadParallelism: plan.maxParallelToolCalls > 1,
      serializeWrites: true,
    },
    stopConditions: ["request_satisfied", "state_change_verified"],
    escalationRules: [
      "escalate_to_balanced_when_hidden_complexity_is_found",
      "preserve_user_changes_and_workspace_scope",
    ],
  };
}

export function formatWorkflowAccelerationPlan(
  plan: WorkflowAccelerationPlan,
): string {
  return [
    "[Workflow Acceleration]",
    `mode: ${plan.mode}`,
    `speed_priority: ${plan.speedPriority}`,
    `speed_class: ${plan.speedClass}`,
    `expected_latency: ${plan.expectedLatency}`,
    `verification_depth: ${plan.verificationDepth}`,
    `max_parallel_tool_calls: ${plan.maxParallelToolCalls}`,
    `context: ${plan.contextStrategy}`,
    `execution: ${plan.executionStrategy}`,
    `verification: ${plan.verificationStrategy}`,
    `rules: ${plan.rules.join(", ")}`,
  ].join("\n");
}

export function formatWorkflowDecisionPattern(
  pattern: WorkflowDecisionPattern,
): string {
  return [
    "[Workflow Decision Pattern]",
    `id: ${pattern.id}`,
    `objective: ${pattern.objective}`,
    `speed_class: ${pattern.speedClass}`,
    `expected_latency: ${pattern.expectedLatency}`,
    `verification_depth: ${pattern.verificationDepth}`,
    `first_pass: ${pattern.firstPassActions.join(", ")}`,
    `context_budget: files=${pattern.contextBudget.maxInitialFiles}, searches=${pattern.contextBudget.maxInitialSearches}, prefer_cache=${pattern.contextBudget.preferCache}`,
    `parallelism: max=${pattern.parallelism.maxParallelToolCalls}, safe_reads=${pattern.parallelism.safeReadParallelism}, serialize_writes=${pattern.parallelism.serializeWrites}`,
    `stop_conditions: ${pattern.stopConditions.join(", ")}`,
    `escalation: ${pattern.escalationRules.join(", ")}`,
  ].join("\n");
}
