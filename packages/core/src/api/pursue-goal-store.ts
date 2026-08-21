import * as fs from "node:fs";
import * as path from "node:path";

export type PursueGoalStatus =
  | "pending"
  | "active"
  | "completed"
  | "blocked"
  | "cancelled";

type GoalPlanStepStatus = "pending" | "in_progress" | "completed" | "failed";

export interface PursueGoalRow {
  id: number;
  title: string;
  description: string | null;
  priority: number;
  status: PursueGoalStatus;
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

export interface PursueGoalPlanStep {
  id: number;
  description: string;
  status: GoalPlanStepStatus;
  depends_on: number[];
}

export interface PursueGoalPlan {
  id: string;
  title: string;
  status: "active" | "completed" | "cancelled";
  steps: PursueGoalPlanStep[];
  created_at: string;
  updated_at: string;
}

export interface PursueGoalSnapshot {
  active: PursueGoalRow | null;
  activePlan: PursueGoalPlan | null;
  goals: PursueGoalRow[];
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

interface PersistedState {
  nextGoalId: number;
  nextStepId: number;
  goals: PursueGoalRow[];
  plans: PursueGoalPlan[];
}

function now(): string {
  return new Date().toISOString();
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class PursueGoalStore {
  private state: PersistedState;
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "pursue-goals.json");
    this.state = this.load();
  }

  snapshot(): PursueGoalSnapshot {
    const goals = [...this.state.goals].sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at),
    );
    const active =
      goals.find((goal) => goal.status === "active" || goal.status === "pending") ||
      null;
    const activePlan = active
      ? this.state.plans.find((plan) => plan.id === `goal-plan-${active.id}`) || null
      : null;
    const completedSteps = active?.completed_steps || 0;
    const totalSteps = active?.total_steps || 0;
    const nextStep =
      activePlan?.steps.find((step) => step.status === "in_progress" || step.status === "pending")
        ?.description || null;

    return {
      active: active ? clone(active) : null,
      activePlan: activePlan ? clone(activePlan) : null,
      goals: clone(goals),
      summary: {
        hasActiveGoal: Boolean(active),
        activeGoalId: active?.id ?? null,
        activePlanId: activePlan?.id ?? null,
        progress: active?.progress ?? 0,
        completedSteps,
        totalSteps,
        nextStep,
      },
    };
  }

  create(input: {
    objective: string;
    description?: string;
    steps?: string[];
    replaceExisting?: boolean;
  }): PursueGoalSnapshot {
    const title = input.objective.trim();
    if (!title) throw new Error("objective is required");

    if (input.replaceExisting) {
      for (const goal of this.state.goals) {
        if (goal.status === "active" || goal.status === "pending") {
          this.transition(goal, "cancelled", "Replaced by a newer pursued goal");
        }
      }
    }

    const createdAt = now();
    const goalId = this.state.nextGoalId++;
    const descriptions = (input.steps || []).map((step) => step.trim()).filter(Boolean);
    const normalizedSteps = descriptions.length > 0 ? descriptions : [title];
    const stepIds = normalizedSteps.map(() => this.state.nextStepId++);
    const planId = `goal-plan-${goalId}`;
    const goal: PursueGoalRow = {
      id: goalId,
      title,
      description: input.description?.trim() || null,
      priority: 0,
      status: "active",
      status_reason: null,
      progress: 0,
      total_steps: normalizedSteps.length,
      completed_steps: 0,
      context: null,
      source: "pursue-goal",
      last_pursued_at: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
    };
    const plan: PursueGoalPlan = {
      id: planId,
      title,
      status: "active",
      steps: normalizedSteps.map((description, index) => ({
        id: stepIds[index],
        description,
        status: index === 0 ? "in_progress" : "pending",
        depends_on: index === 0 ? [] : [stepIds[index - 1]],
      })),
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.state.goals.push(goal);
    this.state.plans.push(plan);
    this.persist();
    return this.snapshot();
  }

  update(
    goalId: number,
    patch: {
      status?: PursueGoalStatus;
      statusReason?: string;
      completedSteps?: number;
      totalSteps?: number;
      progress?: number;
    },
  ): PursueGoalSnapshot {
    const goal = this.state.goals.find((item) => item.id === goalId);
    if (!goal) throw new Error("Goal not found");
    const plan = this.state.plans.find((item) => item.id === `goal-plan-${goal.id}`);
    const changedAt = now();

    if (patch.status) this.transition(goal, patch.status, patch.statusReason);
    if (typeof patch.totalSteps === "number" && Number.isInteger(patch.totalSteps)) {
      goal.total_steps = Math.max(0, patch.totalSteps);
    }
    if (typeof patch.completedSteps === "number" && Number.isInteger(patch.completedSteps)) {
      goal.completed_steps = Math.max(0, Math.min(goal.total_steps, patch.completedSteps));
    }
    if (typeof patch.progress === "number") goal.progress = clampProgress(patch.progress);
    else if (goal.total_steps > 0) goal.progress = goal.completed_steps / goal.total_steps;
    if (goal.status === "completed") {
      goal.completed_steps = goal.total_steps;
      goal.progress = 1;
    }
    goal.status_reason = patch.statusReason?.trim() || goal.status_reason;
    goal.updated_at = changedAt;
    goal.last_pursued_at = changedAt;

    if (plan) {
      if (goal.status === "completed") {
        plan.status = "completed";
        for (const step of plan.steps) step.status = "completed";
      } else if (goal.status === "cancelled" || goal.status === "blocked") {
        plan.status = "cancelled";
      } else {
        plan.status = "active";
        const completed = goal.completed_steps;
        plan.steps.forEach((step, index) => {
          step.status = index < completed ? "completed" : index === completed ? "in_progress" : "pending";
        });
      }
      plan.updated_at = changedAt;
    }

    this.persist();
    return this.snapshot();
  }

  private transition(goal: PursueGoalRow, status: PursueGoalStatus, reason?: string): void {
    goal.status = status;
    if (reason?.trim()) goal.status_reason = reason.trim();
  }

  private load(): PersistedState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<PersistedState>;
      if (!Array.isArray(parsed.goals) || !Array.isArray(parsed.plans)) throw new Error("invalid state");
      return {
        nextGoalId: Number.isInteger(parsed.nextGoalId) ? Math.max(1, parsed.nextGoalId as number) : 1,
        nextStepId: Number.isInteger(parsed.nextStepId) ? Math.max(1, parsed.nextStepId as number) : 1,
        goals: parsed.goals as PursueGoalRow[],
        plans: parsed.plans as PursueGoalPlan[],
      };
    } catch {
      return { nextGoalId: 1, nextStepId: 1, goals: [], plans: [] };
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filePath);
  }
}
