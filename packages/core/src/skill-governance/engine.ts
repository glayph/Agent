import crypto from "crypto";

export interface GovernanceRule {
  id: string;
  pattern: string;
  action: "warn" | "block";
  enabled: boolean;
  description: string;
  priority?: number;
  hitCount?: number;
  lastHitAt?: string;
}

export interface Violation {
  rule_id: string;
  description: string;
  action: "warn" | "block";
  pattern: string;
  priority: number;
}

export class RuleEngine {
  private _builtinRules: GovernanceRule[] = [];
  private _hitCounters: Map<string, number> = new Map();

  addRule(rule: GovernanceRule): boolean {
    rule.hitCount = 0;
    rule.priority = rule.priority ?? 0;
    this._builtinRules.push(rule);
    return true;
  }

  removeRule(ruleId: string): boolean {
    this._builtinRules = this._builtinRules.filter((r) => r.id !== ruleId);
    this._hitCounters.delete(ruleId);
    return true;
  }

  toggleRule(ruleId: string): boolean {
    for (const r of this._builtinRules) {
      if (r.id === ruleId) {
        r.enabled = !r.enabled;
        return true;
      }
    }
    return false;
  }

  refineRule(ruleId: string, updates: Partial<GovernanceRule>): boolean {
    for (const r of this._builtinRules) {
      if (r.id === ruleId) {
        Object.assign(r, updates);
        return true;
      }
    }
    return false;
  }

  checkToolCall(
    toolName: string,
    _toolArgs: Record<string, unknown>,
  ): Violation[] {
    const violations: Violation[] = [];
    const sorted = [...this._builtinRules].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );
    for (const rule of sorted) {
      if (!rule.enabled) continue;
      if (toolName.includes(rule.pattern.replace(/\*/g, ""))) {
        rule.hitCount = (rule.hitCount || 0) + 1;
        rule.lastHitAt = new Date().toISOString();
        violations.push({
          rule_id: rule.id,
          description: rule.description,
          action: rule.action,
          pattern: rule.pattern,
          priority: rule.priority ?? 0,
        });
        if (rule.action === "block") break;
      }
    }
    return violations;
  }

  checkPlanStep(description: string): Violation[] {
    const violations: Violation[] = [];
    for (const rule of this._builtinRules) {
      if (!rule.enabled) continue;
      if (description.toLowerCase().includes(rule.pattern.toLowerCase())) {
        violations.push({
          rule_id: rule.id,
          description: rule.description,
          action: rule.action,
          pattern: rule.pattern,
          priority: rule.priority ?? 0,
        });
      }
    }
    return violations;
  }

  getRules(): GovernanceRule[] {
    return [...this._builtinRules];
  }

  getRuleHitCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const rule of this._builtinRules) {
      counts.set(rule.id, rule.hitCount || 0);
    }
    return counts;
  }
}

export interface PlanStep {
  id: number;
  description: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  depends_on?: number[];
}

export interface Plan {
  id: string;
  title: string;
  steps: PlanStep[];
  status: "active" | "completed" | "cancelled";
  created_at: string;
  updated_at: string;
}

const DEAD_PLAN_MS = 24 * 60 * 60 * 1000;

export class SelfPlanner {
  private _plans: Map<string, Plan> = new Map();

  async initAsync(): Promise<void> {
    this._validateInProgressSteps();
    this._purgeDeadPlans();
  }

  private _validateInProgressSteps(): void {
    for (const plan of this._plans.values()) {
      if (plan.status !== "active") continue;
      let anyInProgress = false;
      for (const step of plan.steps) {
        if (step.status === "in_progress") {
          anyInProgress = true;
          const deps = step.depends_on || [];
          const allDone = deps.every(
            (d) =>
              d >= 0 &&
              d < plan.steps.length &&
              plan.steps[d].status === "completed",
          );
          if (!allDone) {
            step.status = "pending";
          }
        }
      }
      if (
        anyInProgress &&
        !plan.steps.some((s) => s.status === "in_progress")
      ) {
        this._advancePlan(plan);
      }
    }
  }

  private _purgeDeadPlans(): void {
    const now = Date.now();
    const toCancel: string[] = [];
    for (const [planId, plan] of this._plans) {
      if (plan.status !== "active") continue;
      if (plan.steps.some((s) => s.status === "in_progress")) continue;
      const lastUpdated = new Date(plan.updated_at).getTime();
      if (now - lastUpdated > DEAD_PLAN_MS) toCancel.push(planId);
    }
    for (const planId of toCancel) {
      this._plans.delete(planId);
    }
  }

  createPlan(title: string, steps: PlanStep[]): string {
    const planId = crypto.randomUUID();
    const now = new Date().toISOString();
    for (let i = 0; i < steps.length; i++) {
      steps[i].id = i;
      steps[i].status = steps[i].status || "pending";
      steps[i].depends_on = steps[i].depends_on || [];
    }
    this._plans.set(planId, {
      id: planId,
      title,
      steps,
      status: "active",
      created_at: now,
      updated_at: now,
    });
    return planId;
  }

  markStepComplete(planId: string, stepId: number): boolean {
    const plan = this.getPlan(planId);
    if (!plan) return false;
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return false;
    step.status = "completed";
    this._advancePlan(plan);
    plan.updated_at = new Date().toISOString();
    this._checkPlanCompletion(plan);
    return true;
  }

  markStepFailed(planId: string, stepId: number): boolean {
    const plan = this.getPlan(planId);
    if (!plan) return false;
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return false;
    step.status = "failed";
    return true;
  }

  private _advancePlan(plan: Plan): void {
    for (const step of plan.steps) {
      if (step.status !== "pending") continue;
      const deps = step.depends_on || [];
      const allDone = deps.every(
        (d) =>
          d >= 0 &&
          d < plan.steps.length &&
          plan.steps[d].status === "completed",
      );
      if (allDone) step.status = "in_progress";
    }
  }

  private _checkPlanCompletion(plan: Plan): void {
    if (plan.status !== "active") return;
    if (
      plan.steps.every((s) => s.status === "completed" || s.status === "failed")
    ) {
      plan.status = "completed";
    }
  }

  revisePlan(
    planId: string,
    newSteps: PlanStep[],
    afterStep: number = -1,
  ): boolean {
    const plan = this.getPlan(planId);
    if (!plan) return false;
    const baseIndex = afterStep >= 0 ? afterStep + 1 : plan.steps.length;
    for (let i = 0; i < newSteps.length; i++) {
      newSteps[i].id = baseIndex + i;
      newSteps[i].status = newSteps[i].status || "pending";
      const deps = newSteps[i].depends_on || [];
      newSteps[i].depends_on = deps.map((d) =>
        d < baseIndex ? d : d + newSteps.length,
      );
    }
    plan.steps.splice(baseIndex, 0, ...newSteps);
    plan.updated_at = new Date().toISOString();
    return true;
  }

  cancelPlan(planId: string): boolean {
    this._plans.delete(planId);
    return true;
  }

  getPlan(planId: string): Plan | undefined {
    return this._plans.get(planId);
  }

  getActivePlan(): Plan | undefined {
    for (const plan of this._plans.values()) {
      if (plan.status !== "active") continue;
      if (
        plan.steps.some(
          (s) => s.status === "pending" || s.status === "in_progress",
        )
      ) {
        return plan;
      }
    }
    return undefined;
  }

  planSummary():
    | {
        title: string;
        total_steps: number;
        completed: number;
        failed: number;
        currentStep?: string;
      }
    | undefined {
    const plan = this.getActivePlan();
    if (!plan) return undefined;
    return {
      title: plan.title,
      total_steps: plan.steps.length,
      completed: plan.steps.filter((s) => s.status === "completed").length,
      failed: plan.steps.filter((s) => s.status === "failed").length,
      currentStep: plan.steps.find((s) => s.status === "in_progress")
        ?.description,
    };
  }

  addStep(
    planId: string,
    description: string,
    dependsOn: number[] = [],
  ): boolean {
    const plan = this.getPlan(planId);
    if (!plan) return false;
    plan.steps.push({
      id: plan.steps.length,
      description,
      status: "pending",
      depends_on: dependsOn,
    });
    plan.updated_at = new Date().toISOString();
    return true;
  }

  getIncompleteGoals(): Array<{
    id: number;
    title: string;
    description: string | null;
  }> {
    return [];
  }
}

export interface GovernanceConfig {
  enabled?: boolean;
}

export interface EngineStatus {
  enabled: boolean;
  rules_count: number;
  active_plan:
    | { title: string; total_steps: number; completed: number }
    | undefined;
}

export class SkillGovernanceEngine {
  private config: Required<GovernanceConfig>;
  public selfPlanner: SelfPlanner;
  public ruleEngine: RuleEngine;

  constructor(config: GovernanceConfig = {}) {
    this.config = { enabled: config.enabled ?? false };
    this.selfPlanner = new SelfPlanner();
    this.ruleEngine = new RuleEngine();
  }

  async initAsync(): Promise<void> {
    await this.selfPlanner.initAsync();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  set enabled(val: boolean) {
    this.config.enabled = val;
  }

  getRuleViolations(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Violation[] {
    return this.ruleEngine.checkToolCall(toolName, toolArgs);
  }

  getStatus(): EngineStatus {
    return {
      enabled: this.config.enabled,
      rules_count: this.ruleEngine.getRules().length,
      active_plan: this.selfPlanner.planSummary(),
    };
  }
}
