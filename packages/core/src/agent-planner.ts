/**
 * AgentPlanner: Enhanced multi-step planning with backtracking
 * - Decompose goal into subgoals
 * - Estimate effort and likelihood for each plan
 * - Prune impossible/inefficient plans
 * - Execute with backtracking on failure
 */

export interface Goal {
  id: string;
  description: string;
  priority: number;
}

export interface PlanStep {
  id: string;
  goal: string;
  action: string;
  preconditions: string[];
  estimatedCost: number;
  successLikelihood: number;
  alternates?: string[];
  /**
   * Phase 4: The specialist ID that should handle this step (e.g. "sage",
   * "forge", "scout"). Set by the planner when multi-agent mode is active.
   * Undefined means the default orchestrator agent handles it.
   */
  assignedSpecialist?: string;
}

export interface Plan {
  id: string;
  steps: PlanStep[];
  totalCost: number;
  likelihood: number;
  alternatives?: Plan[];
}

export class AgentPlanner {
  private planCache: Map<string, Plan[]> = new Map();
  private executionHistory: Map<
    string,
    { success: boolean; duration: number }
  > = new Map();

  private readonly MAX_PLANS = 5;
  private readonly MIN_LIKELIHOOD = 0.3;

  /**
   * Generate plans for a goal
   */
  async generatePlans(
    goal: string,
    maxPlans: number = this.MAX_PLANS,
  ): Promise<Plan[]> {
    // Check cache
    const cached = this.planCache.get(goal);
    if (cached) {
      return cached;
    }

    const plans: Plan[] = [];

    // Strategy 1: Linear decomposition
    plans.push(this.generateLinearPlan(goal));

    // Strategy 2: Parallel decomposition
    plans.push(this.generateParallelPlan(goal));

    // Strategy 3: Hierarchical decomposition
    plans.push(this.generateHierarchicalPlan(goal));

    // Strategy 4: Risk-mitigation plan
    plans.push(this.generateRiskMitigatedPlan(goal));

    // Strategy 5: Resource-optimized plan
    plans.push(this.generateResourceOptimizedPlan(goal));

    // Score and sort by likelihood
    const scored = plans
      .filter((p) => p.likelihood >= this.MIN_LIKELIHOOD)
      .sort((a, b) => b.likelihood - a.likelihood)
      .slice(0, maxPlans);

    // Cache
    this.planCache.set(goal, scored);

    return scored;
  }

  /**
   * Linear plan: sequential execution
   */
  private generateLinearPlan(goal: string): Plan {
    const steps: PlanStep[] = [
      {
        id: "step_1",
        goal: goal,
        action: "Analyze requirements",
        preconditions: [],
        estimatedCost: 1,
        successLikelihood: 0.95,
      },
      {
        id: "step_2",
        goal: goal,
        action: "Plan execution",
        preconditions: ["step_1"],
        estimatedCost: 2,
        successLikelihood: 0.9,
      },
      {
        id: "step_3",
        goal: goal,
        action: "Execute plan",
        preconditions: ["step_2"],
        estimatedCost: 5,
        successLikelihood: 0.85,
      },
      {
        id: "step_4",
        goal: goal,
        action: "Verify results",
        preconditions: ["step_3"],
        estimatedCost: 1,
        successLikelihood: 0.9,
      },
    ];

    return {
      id: "plan_linear",
      steps,
      totalCost: steps.reduce((sum, s) => sum + s.estimatedCost, 0),
      likelihood: steps.reduce((prod, s) => prod * s.successLikelihood, 1),
    };
  }

  /**
   * Parallel plan: concurrent execution where possible
   */
  private generateParallelPlan(goal: string): Plan {
    const steps: PlanStep[] = [
      {
        id: "step_1a",
        goal: goal,
        action: "Gather information",
        preconditions: [],
        estimatedCost: 2,
        successLikelihood: 0.9,
      },
      {
        id: "step_1b",
        goal: goal,
        action: "Identify resources",
        preconditions: [],
        estimatedCost: 2,
        successLikelihood: 0.9,
      },
      {
        id: "step_2",
        goal: goal,
        action: "Create implementation plan",
        preconditions: ["step_1a", "step_1b"],
        estimatedCost: 1,
        successLikelihood: 0.88,
      },
      {
        id: "step_3",
        goal: goal,
        action: "Execute",
        preconditions: ["step_2"],
        estimatedCost: 4,
        successLikelihood: 0.85,
      },
    ];

    return {
      id: "plan_parallel",
      steps,
      totalCost: steps.reduce((sum, s) => sum + s.estimatedCost, 0),
      likelihood: steps.reduce((prod, s) => prod * s.successLikelihood, 1),
    };
  }

  /**
   * Hierarchical plan: top-down decomposition
   */
  private generateHierarchicalPlan(goal: string): Plan {
    const steps: PlanStep[] = [
      {
        id: "step_1",
        goal: goal,
        action: "Decompose into subgoals",
        preconditions: [],
        estimatedCost: 1,
        successLikelihood: 0.9,
      },
      {
        id: "step_2",
        goal: "subgoal_1",
        action: "Solve subgoal 1",
        preconditions: ["step_1"],
        estimatedCost: 3,
        successLikelihood: 0.85,
      },
      {
        id: "step_3",
        goal: "subgoal_2",
        action: "Solve subgoal 2",
        preconditions: ["step_2"],
        estimatedCost: 3,
        successLikelihood: 0.85,
      },
      {
        id: "step_4",
        goal: goal,
        action: "Integrate results",
        preconditions: ["step_2", "step_3"],
        estimatedCost: 1,
        successLikelihood: 0.88,
      },
    ];

    return {
      id: "plan_hierarchical",
      steps,
      totalCost: steps.reduce((sum, s) => sum + s.estimatedCost, 0),
      likelihood: steps.reduce((prod, s) => prod * s.successLikelihood, 1),
    };
  }

  /**
   * Risk-mitigated plan: includes fallbacks
   */
  private generateRiskMitigatedPlan(goal: string): Plan {
    const steps: PlanStep[] = [
      {
        id: "step_1",
        goal: goal,
        action: "Identify risks",
        preconditions: [],
        estimatedCost: 1,
        successLikelihood: 0.95,
      },
      {
        id: "step_2",
        goal: goal,
        action: "Plan mitigation strategies",
        preconditions: ["step_1"],
        estimatedCost: 2,
        successLikelihood: 0.9,
      },
      {
        id: "step_3",
        goal: goal,
        action: "Execute with monitoring",
        preconditions: ["step_2"],
        estimatedCost: 6,
        successLikelihood: 0.92,
      },
    ];

    return {
      id: "plan_risk_mitigated",
      steps,
      totalCost: steps.reduce((sum, s) => sum + s.estimatedCost, 0),
      likelihood: steps.reduce((prod, s) => prod * s.successLikelihood, 1),
    };
  }

  /**
   * Resource-optimized plan: minimize cost
   */
  private generateResourceOptimizedPlan(goal: string): Plan {
    const steps: PlanStep[] = [
      {
        id: "step_1",
        goal: goal,
        action: "Find optimal approach",
        preconditions: [],
        estimatedCost: 1,
        successLikelihood: 0.88,
      },
      {
        id: "step_2",
        goal: goal,
        action: "Execute efficiently",
        preconditions: ["step_1"],
        estimatedCost: 3,
        successLikelihood: 0.83,
      },
    ];

    return {
      id: "plan_optimized",
      steps,
      totalCost: steps.reduce((sum, s) => sum + s.estimatedCost, 0),
      likelihood: steps.reduce((prod, s) => prod * s.successLikelihood, 1),
    };
  }

  /**
   * Execute plan with backtracking on failure
   */
  async executePlanWithBacktracking(
    plans: Plan[],
  ): Promise<{ success: boolean; plan: Plan; error?: string }> {
    // Sort by likelihood
    const sorted = [...plans].sort((a, b) => b.likelihood - a.likelihood);

    for (const plan of sorted) {
      try {
        // Simulate execution
        const success = await this.simulateExecution(plan);

        if (success) {
          this.executionHistory.set(plan.id, { success: true, duration: 0 });
          return { success: true, plan };
        }
      } catch {
        // Try next plan
        continue;
      }
    }

    return {
      success: false,
      plan: sorted[0],
      error: "All plans failed",
    };
  }

  /**
   * Simulate plan execution
   */
  private async simulateExecution(plan: Plan): Promise<boolean> {
    // In real implementation, execute actual steps
    // For now, use likelihood as success probability
    const random = Math.random();
    return random < plan.likelihood;
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.planCache.clear();
  }

  /**
   * Get execution stats
   */
  getStats(): {
    totalExecutions: number;
    successfulExecutions: number;
    successRate: number;
  } {
    const values = Array.from(this.executionHistory.values());
    const successful = values.filter((v) => v.success).length;

    return {
      totalExecutions: values.length,
      successfulExecutions: successful,
      successRate: values.length > 0 ? successful / values.length : 0,
    };
  }

  /**
   * Phase 4: Annotate each step of a plan with the best-fit specialist.
   *
   * Heuristic rules (fast, no LLM call):
   *  - Steps involving "analyse", "research", "compare", "review" → sage
   *  - Steps involving "code", "implement", "build", "execute", "test" → forge
   *  - Steps involving "monitor", "health", "metrics", "alert" → scout
   *  - Everything else → undefined (handled by the default orchestrator)
   *
   * If availableSpecialists is provided, only assigns specialists that are in
   * the list (so disabled specialists are skipped).
   */
  assignSpecialists(plan: Plan, availableSpecialists?: string[]): Plan {
    const isAvailable = (id: string): boolean =>
      !availableSpecialists || availableSpecialists.includes(id);

    const annotated: PlanStep[] = plan.steps.map((step) => {
      const action = step.action.toLowerCase();

      let specialist: string | undefined;

      if (
        isAvailable("sage") &&
        (action.includes("analys") ||
          action.includes("research") ||
          action.includes("compare") ||
          action.includes("review") ||
          action.includes("investigate") ||
          action.includes("gather") ||
          action.includes("summaris") ||
          action.includes("summariz"))
      ) {
        specialist = "sage";
      } else if (
        isAvailable("forge") &&
        (action.includes("code") ||
          action.includes("implement") ||
          action.includes("build") ||
          action.includes("execute") ||
          action.includes("test") ||
          action.includes("deploy") ||
          action.includes("scaffold") ||
          action.includes("write") ||
          action.includes("fix") ||
          action.includes("refactor"))
      ) {
        specialist = "forge";
      } else if (
        isAvailable("scout") &&
        (action.includes("monitor") ||
          action.includes("health") ||
          action.includes("metric") ||
          action.includes("alert") ||
          action.includes("diagnos") ||
          action.includes("check") ||
          action.includes("uptime"))
      ) {
        specialist = "scout";
      }

      return { ...step, assignedSpecialist: specialist };
    });

    return { ...plan, steps: annotated };
  }
}

export const globalAgentPlanner = new AgentPlanner();
