/**
 * autonomy/types.ts
 *
 * Shared types for Agent Miki's persistent autonomous goal system.
 *
 * This subsystem sits *alongside* the existing HeartbeatEngine,
 * TaskScheduler/TaskQueue, SelfImprovementEngine and AutomationManager
 * rather than replacing them: it decides *what is worth doing* when
 * there is no active user task, and hands the resulting work to the
 * existing task scheduler / agent loop for execution.
 */

/** Top-level lifecycle states for the autonomous controller. */
export type AutonomyState =
  | "BOOT"
  | "INITIALIZING"
  | "ACTIVE"
  | "USER_TASK"
  | "AUTONOMOUS"
  | "PLANNING"
  | "EXECUTING"
  | "OBSERVING"
  | "MEMORY_UPDATE"
  | "IDLE_DECISION"
  | "SLEEP"
  | "SHUTDOWN"
  | "ERROR_RECOVERY";

/** The two user-selectable operating modes. */
export type AutonomyMode = "standard" | "turbo";

/**
 * Built-in goal categories. This union is intentionally *not* the only
 * legal value for `GoalCandidate.category` (see the `string & {}` escape
 * hatch below) — new categories can be registered at runtime through
 * `goal-catalog.ts` without touching this file.
 */
export type BuiltinGoalCategory =
  | "USER_FOLLOWUP"
  | "UNFINISHED_WORK"
  | "PROJECT_MAINTENANCE"
  | "CODE_ANALYSIS"
  | "TESTING"
  | "BUG_INVESTIGATION"
  | "RESEARCH"
  | "LEARNING"
  | "MEMORY_MAINTENANCE"
  | "KNOWLEDGE_ORGANIZATION"
  | "SYSTEM_HEALTH"
  | "MODEL_HEALTH"
  | "RESOURCE_OPTIMIZATION"
  | "PLANNING"
  | "EXPERIMENTATION"
  | "DOCUMENTATION"
  | "AUTOMATION"
  | "SELF_EVALUATION";

export type GoalCategory = BuiltinGoalCategory | (string & {});

export type ObjectiveStatus =
  "pending" | "in_progress" | "completed" | "failed" | "aborted" | "blocked";

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  attempts: number;
  lastError?: string | null;
}

/**
 * Persistent record for a single autonomous objective. Shape matches the
 * example given in the spec (section 10) so the on-disk representation is
 * self-explanatory across restarts.
 */
export interface Objective {
  id: string;
  type: GoalCategory;
  status: ObjectiveStatus;
  title: string;
  rationale: string;
  createdAt: number;
  updatedAt: number;
  priority: number;
  progress: number;
  plan: PlanStep[];
  context: Record<string, unknown>;
  result: Record<string, unknown> | string | null;
  /** Number of times this objective has been (re)planned after a failure. */
  replans: number;
  /** sessionId used when this objective's plan is dispatched to the task scheduler */
  sessionId?: string;
  /** id of the scheduled/agent task currently executing this objective, if any */
  activeTaskId?: string;
}

/** Raw signal inputs a goal candidate carries into scoring. */
export interface GoalScoreFactors {
  priority: number; // 0..1 intrinsic importance of the category right now
  usefulness: number; // 0..1 expected benefit if completed
  urgency: number; // 0..1 how time-sensitive this is
  relevance: number; // 0..1 relevance to current project/context
  expectedValue: number; // 0..1 model of value if it succeeds
  unfinishedWorkBonus: number; // 0..1, extra weight for resuming existing work
  resourceCost: number; // 0..1 estimated resource consumption
  risk: number; // 0..1 estimated risk / chance of doing harm or churn
}

export interface GoalCandidate {
  category: GoalCategory;
  title: string;
  rationale: string;
  factors: GoalScoreFactors;
  /** If this candidate resumes an existing objective, its id. */
  resumeObjectiveId?: string;
  /** Suggested initial plan steps; goal-catalog fills this in via buildPlan(). */
  context?: Record<string, unknown>;
}

export interface ScoredGoal {
  candidate: GoalCandidate;
  score: number;
}

/** Snapshot of everything the goal manager needs to make a decision. */
export interface AutonomyContext {
  now: number;
  idleMins: number;
  mode: AutonomyMode;
  unfinishedObjectives: Objective[];
  recentObjectives: Objective[];
  resource: ResourceSnapshot;
  /** Free-form hints pulled from memory/config (topics, project paths, etc). */
  hints: Record<string, unknown>;
}

export interface ResourceSnapshot {
  freeMemPct: number;
  cpus: number;
  activeTasks: number;
  maxConcurrent: number;
  providerAvailable: boolean;
}

/** Structured log event names (spec section 22). Values are the event tag. */
export const AUTONOMY_LOG_EVENTS = {
  AUTONOMY_ENABLED: "AUTONOMY_ENABLED",
  AUTONOMY_DISABLED: "AUTONOMY_DISABLED",
  MODE_CHANGED: "MODE_CHANGED",
  OBJECTIVE_CREATED: "OBJECTIVE_CREATED",
  OBJECTIVE_SELECTED: "OBJECTIVE_SELECTED",
  PLAN_CREATED: "PLAN_CREATED",
  ACTION_STARTED: "ACTION_STARTED",
  ACTION_COMPLETED: "ACTION_COMPLETED",
  ACTION_FAILED: "ACTION_FAILED",
  OBJECTIVE_COMPLETED: "OBJECTIVE_COMPLETED",
  OBJECTIVE_ABORTED: "OBJECTIVE_ABORTED",
  REPLAN: "REPLAN",
  MEMORY_UPDATED: "MEMORY_UPDATED",
  AUTONOMOUS_INTERRUPTED: "AUTONOMOUS_INTERRUPTED",
  AUTONOMOUS_RESUMED: "AUTONOMOUS_RESUMED",
  RESOURCE_THROTTLED: "RESOURCE_THROTTLED",
  AUTO_MODE_ESCALATED: "AUTO_MODE_ESCALATED",
  AUTO_MODE_DEESCALATED: "AUTO_MODE_DEESCALATED",
} as const;

export type AutonomyLogEvent = keyof typeof AUTONOMY_LOG_EVENTS;

export interface AutonomyStatus {
  enabled: boolean;
  mode: AutonomyMode;
  state: AutonomyState;
  currentObjective: Objective | null;
  currentObjectiveDurationMs: number | null;
  nextDecisionInMs: number | null;
  tasksCompleted: number;
  tasksFailed: number;
  lastAction: string | null;
  lastActionAt: number | null;
}
