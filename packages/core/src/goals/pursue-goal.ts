export interface GoalRow {
  id: number;
  title: string;
  description: string | null;
  priority: number;
  status: string;
  status_reason: string | null;
  progress: number;
  total_steps: number;
  completed_steps: number;
  context: string | null;
  source: string | null;
  last_pursued_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanStep {
  id: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  depends_on: number[];
}

export interface Plan {
  id: string;
  title: string;
  status: "active" | "completed" | "cancelled";
  steps: PlanStep[];
  created_at: string;
  updated_at: string;
}

export type PursueGoalStatus =
  "pending" | "active" | "completed" | "blocked" | "cancelled";

export interface PursueGoalCreateInput {
  objective: string;
  description?: string;
  priority?: number;
  context?: Record<string, unknown> | string;
  steps?: Array<string | Partial<PlanStep>>;
  replaceExisting?: boolean;
  source?: string;
}

export interface PursueGoalUpdateInput {
  goalId?: number;
  objective?: string;
  description?: string | null;
  priority?: number;
  status?: PursueGoalStatus;
  statusReason?: string | null;
  progress?: number;
  completedSteps?: number;
  totalSteps?: number;
  context?: Record<string, unknown> | string | null;
  steps?: Array<string | Partial<PlanStep>>;
}

export interface PursueGoalSnapshot {
  active: GoalRow | null;
  activePlan: Plan | null;
  goals: GoalRow[];
  summary: {
    hasActiveGoal: boolean;
    activeGoalId: number | null;
    activePlanId: string | null;
    progress: number;
    completedSteps: number;
    totalSteps: number;
    nextStep: string | null;
  };
}

export function createPursueGoal(
  _goalRepo: unknown,
  _input: PursueGoalCreateInput,
): PursueGoalSnapshot {
  return {
    active: null,
    activePlan: null,
    goals: [],
    summary: {
      hasActiveGoal: false,
      activeGoalId: null,
      activePlanId: null,
      progress: 0,
      completedSteps: 0,
      totalSteps: 0,
      nextStep: null,
    },
  };
}

export function updatePursueGoal(
  _goalRepo: unknown,
  _input: PursueGoalUpdateInput,
): PursueGoalSnapshot {
  return {
    active: null,
    activePlan: null,
    goals: [],
    summary: {
      hasActiveGoal: false,
      activeGoalId: null,
      activePlanId: null,
      progress: 0,
      completedSteps: 0,
      totalSteps: 0,
      nextStep: null,
    },
  };
}

export function getPursueGoalSnapshot(
  _goalRepo: unknown,
  _limit = 25,
): PursueGoalSnapshot {
  return {
    active: null,
    activePlan: null,
    goals: [],
    summary: {
      hasActiveGoal: false,
      activeGoalId: null,
      activePlanId: null,
      progress: 0,
      completedSteps: 0,
      totalSteps: 0,
      nextStep: null,
    },
  };
}

export function formatPursueGoalBlock(_goalRepo: unknown): string {
  return "";
}
