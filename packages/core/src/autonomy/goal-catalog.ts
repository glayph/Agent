import * as crypto from "crypto";
import type {
  AutonomyContext,
  BuiltinGoalCategory,
  GoalCandidate,
  GoalCategory,
  Objective,
  PlanStep,
} from "./types.js";

export interface GoalDefinition {
  category: GoalCategory;
  description: string;
  /** Look at the current context and propose 0 or more candidates. Must be
   * driven by real signals in `ctx` — never return a candidate just to
   * fill a slot (spec section 7: no "think... think..." filler tasks). */
  probe(ctx: AutonomyContext): GoalCandidate[];
  /** Turn a chosen candidate into concrete, ordered plan steps. */
  buildPlan(candidate: GoalCandidate, ctx: AutonomyContext): PlanStep[];
}

function step(description: string): PlanStep {
  return {
    id: crypto.randomUUID(),
    description,
    status: "pending",
    attempts: 0,
    lastError: null,
  };
}

/** Shared plan shape: every category follows the same
 * inspect → identify → act → verify → record arc from the spec's example
 * (section 11), just with category-specific step text. This is the "equal
 * basic logic across categories" the operator asked for. */
function genericPlan(steps: string[]): PlanStep[] {
  return steps.map(step);
}

function mostRecent(
  objectives: Objective[],
  category: GoalCategory,
): Objective | undefined {
  return objectives.find((o) => o.type === category);
}

function minutesSince(ts: number | undefined, now: number): number {
  if (!ts) return Infinity;
  return (now - ts) / 60000;
}

const registry = new Map<GoalCategory, GoalDefinition>();

export function registerGoalDefinition(def: GoalDefinition): void {
  registry.set(def.category, def);
}

export function getGoalDefinition(
  category: GoalCategory,
): GoalDefinition | undefined {
  return registry.get(category);
}

export function listGoalDefinitions(): GoalDefinition[] {
  return Array.from(registry.values());
}

// ---------------------------------------------------------------------------
// Built-in definitions. Each is intentionally small: it looks at one or two
// concrete signals from AutonomyContext and either proposes nothing (the
// common case) or one well-founded candidate.
// ---------------------------------------------------------------------------

function def(
  category: BuiltinGoalCategory,
  description: string,
  probe: GoalDefinition["probe"],
  planSteps: (c: GoalCandidate) => string[],
): GoalDefinition {
  return {
    category,
    description,
    probe,
    buildPlan: (c) => genericPlan(planSteps(c)),
  };
}

registerGoalDefinition(
  def(
    "USER_FOLLOWUP",
    "Resume something the user asked about but was left open",
    (ctx) => {
      const pending =
        (ctx.hints.pendingFollowups as string[] | undefined) ?? [];
      if (pending.length === 0) return [];
      const [first] = pending;
      return [
        {
          category: "USER_FOLLOWUP",
          title: `Follow up: ${first}`,
          rationale:
            "A user request was flagged for follow-up but never closed out.",
          factors: {
            priority: 0.9,
            usefulness: 0.9,
            urgency: 0.8,
            relevance: 1,
            expectedValue: 0.9,
            unfinishedWorkBonus: 0.7,
            resourceCost: 0.3,
            risk: 0.2,
          },
          context: { followup: first },
        },
      ];
    },
    (c) => [
      `Re-read the original request: ${c.context?.followup}`,
      "Check whether context has changed since it was raised",
      "Complete the outstanding part of the request",
      "Verify the result addresses the original ask",
      "Record outcome and clear the follow-up flag",
    ],
  ),
);

registerGoalDefinition(
  def(
    "UNFINISHED_WORK",
    "Resume the highest-priority incomplete objective",
    (ctx) => {
      const candidates = ctx.unfinishedObjectives.filter(
        (o) => o.type !== "USER_FOLLOWUP",
      );
      if (candidates.length === 0) return [];
      const target = candidates[0];
      return [
        {
          category: "UNFINISHED_WORK",
          title: `Resume: ${target.title}`,
          rationale: `Objective ${target.id} is ${target.status} at ${Math.round(target.progress * 100)}% progress.`,
          resumeObjectiveId: target.id,
          factors: {
            priority: Math.max(0.5, target.priority),
            usefulness: 0.8,
            urgency: 0.5 + Math.min(0.4, target.replans * 0.1),
            relevance: 0.9,
            expectedValue: 0.8,
            unfinishedWorkBonus: 1,
            resourceCost: 0.4,
            risk: 0.2 + Math.min(0.3, target.replans * 0.1),
          },
          context: { resumedObjectiveId: target.id },
        },
      ];
    },
    (c) => [
      `Load prior state for objective ${c.context?.resumedObjectiveId}`,
      "Validate that the plan is still valid given current state",
      "Continue execution from the last completed step",
      "Verify progress before marking further steps done",
      "Update the objective's persisted progress",
    ],
  ),
);

registerGoalDefinition(
  def(
    "PROJECT_MAINTENANCE",
    "Periodic health pass over an active project",
    (ctx) => {
      const projects = (ctx.hints.projects as string[] | undefined) ?? [];
      if (projects.length === 0) return [];
      const last = mostRecent(ctx.recentObjectives, "PROJECT_MAINTENANCE");
      if (minutesSince(last?.updatedAt, ctx.now) < 60 * 12) return [];
      const target = projects[ctx.now % projects.length];
      return [
        {
          category: "PROJECT_MAINTENANCE",
          title: `Maintenance pass: ${target}`,
          rationale: "No maintenance pass on this project in the last 12h.",
          factors: {
            priority: 0.5,
            usefulness: 0.7,
            urgency: 0.3,
            relevance: 0.8,
            expectedValue: 0.6,
            unfinishedWorkBonus: 0,
            resourceCost: 0.4,
            risk: 0.2,
          },
          context: { project: target },
        },
      ];
    },
    (c) => [
      `Inspect current state of ${c.context?.project}`,
      "Check for stale branches, TODOs, or broken tooling",
      "Address small, safe cleanups directly",
      "Flag larger issues as new UNFINISHED_WORK objectives",
      "Record findings",
    ],
  ),
);

registerGoalDefinition(
  def(
    "CODE_ANALYSIS",
    "Static review of recently changed code",
    (ctx) => {
      const changed =
        (ctx.hints.recentlyChangedFiles as string[] | undefined) ?? [];
      if (changed.length === 0) return [];
      return [
        {
          category: "CODE_ANALYSIS",
          title: `Analyze ${changed.length} recently changed file(s)`,
          rationale: "Recent changes have not had a follow-up analysis pass.",
          factors: {
            priority: 0.5,
            usefulness: 0.7,
            urgency: 0.3,
            relevance: 0.8,
            expectedValue: 0.6,
            unfinishedWorkBonus: 0,
            resourceCost: 0.4,
            risk: 0.2,
          },
          context: { files: changed.slice(0, 20) },
        },
      ];
    },
    (c) => [
      `Read the changed files: ${(c.context?.files as string[] | undefined)?.join(", ")}`,
      "Look for correctness, style, and complexity issues",
      "Fix small, unambiguous issues directly",
      "Record larger issues as BUG_INVESTIGATION or UNFINISHED_WORK",
      "Summarize the analysis",
    ],
  ),
);

registerGoalDefinition(
  def(
    "TESTING",
    "Improve or verify test coverage/reliability",
    (ctx) => {
      const failing = (ctx.hints.failingTests as string[] | undefined) ?? [];
      if (failing.length > 0) {
        return [
          {
            category: "TESTING",
            title: `Investigate ${failing.length} failing test(s)`,
            rationale: "Tests are currently red.",
            factors: {
              priority: 0.8,
              usefulness: 0.9,
              urgency: 0.7,
              relevance: 0.9,
              expectedValue: 0.8,
              unfinishedWorkBonus: 0,
              resourceCost: 0.4,
              risk: 0.2,
            },
            context: { failingTests: failing },
          },
        ];
      }
      const last = mostRecent(ctx.recentObjectives, "TESTING");
      if (minutesSince(last?.updatedAt, ctx.now) < 60 * 24) return [];
      return [
        {
          category: "TESTING",
          title: "Review test coverage for gaps",
          rationale: "No coverage review in the last day.",
          factors: {
            priority: 0.3,
            usefulness: 0.6,
            urgency: 0.2,
            relevance: 0.6,
            expectedValue: 0.5,
            unfinishedWorkBonus: 0,
            resourceCost: 0.4,
            risk: 0.1,
          },
          context: {},
        },
      ];
    },
    () => [
      "Run the test suite and capture failures",
      "Identify the failure pattern (flaky vs. real regression)",
      "Inspect related source for the root cause",
      "Implement a fix or add missing coverage",
      "Re-run tests to verify",
      "Record the result",
    ],
  ),
);

registerGoalDefinition(
  def(
    "BUG_INVESTIGATION",
    "Investigate a recurring or recent failure",
    (ctx) => {
      const errors = (ctx.hints.recentErrors as string[] | undefined) ?? [];
      if (errors.length === 0) return [];
      return [
        {
          category: "BUG_INVESTIGATION",
          title: `Investigate: ${errors[0]}`,
          rationale: `${errors.length} recent error(s) logged.`,
          factors: {
            priority: 0.7,
            usefulness: 0.8,
            urgency: 0.6 + Math.min(0.3, errors.length * 0.05),
            relevance: 0.8,
            expectedValue: 0.7,
            unfinishedWorkBonus: 0,
            resourceCost: 0.4,
            risk: 0.25,
          },
          context: { errors: errors.slice(0, 10) },
        },
      ];
    },
    (c) => [
      `Reproduce or trace: ${(c.context?.errors as string[] | undefined)?.[0]}`,
      "Isolate the root cause",
      "Implement and test a fix",
      "Verify the error no longer recurs",
      "Record the failure and fix in memory",
    ],
  ),
);

registerGoalDefinition(
  def(
    "RESEARCH",
    "Research a configured topic of interest",
    (ctx) => {
      const topics = (ctx.hints.researchTopics as string[] | undefined) ?? [];
      if (topics.length === 0) return [];
      const last = mostRecent(ctx.recentObjectives, "RESEARCH");
      if (minutesSince(last?.updatedAt, ctx.now) < 60 * 24) return [];
      const topic = topics[ctx.now % topics.length];
      return [
        {
          category: "RESEARCH",
          title: `Research: ${topic}`,
          rationale: "Configured research topic due for a refresh.",
          factors: {
            priority: 0.3,
            usefulness: 0.6,
            urgency: 0.2,
            relevance: 0.6,
            expectedValue: 0.5,
            unfinishedWorkBonus: 0,
            resourceCost: 0.3,
            risk: 0.1,
          },
          context: { topic },
        },
      ];
    },
    (c) => [
      `Gather current information on ${c.context?.topic}`,
      "Evaluate source credibility and recency",
      "Summarize key findings",
      "Store durable facts in memory",
      "Note any follow-up questions",
    ],
  ),
);

registerGoalDefinition(
  def(
    "LEARNING",
    "Extract lessons from recent failures",
    (ctx) => {
      const failures = ctx.recentObjectives.filter(
        (o) => o.status === "failed",
      );
      if (failures.length === 0) return [];
      return [
        {
          category: "LEARNING",
          title: `Learn from ${failures.length} recent failure(s)`,
          rationale: "Unreviewed failures carry reusable lessons.",
          factors: {
            priority: 0.4,
            usefulness: 0.7,
            urgency: 0.2,
            relevance: 0.6,
            expectedValue: 0.6,
            unfinishedWorkBonus: 0,
            resourceCost: 0.2,
            risk: 0.1,
          },
          context: { failureIds: failures.map((f) => f.id) },
        },
      ];
    },
    (c) => [
      `Review failed objectives: ${(c.context?.failureIds as string[] | undefined)?.join(", ")}`,
      "Identify the common cause, if any",
      "Turn the cause into an actionable guideline",
      "Store the lesson in memory for future planning",
    ],
  ),
);

registerGoalDefinition(
  def(
    "MEMORY_MAINTENANCE",
    "Organize and prune working/episodic memory",
    (ctx) => {
      const last = mostRecent(ctx.recentObjectives, "MEMORY_MAINTENANCE");
      if (minutesSince(last?.updatedAt, ctx.now) < 60 * 6) return [];
      return [
        {
          category: "MEMORY_MAINTENANCE",
          title: "Organize recent memory",
          rationale: "No memory maintenance pass in the last 6h.",
          factors: {
            priority: 0.3,
            usefulness: 0.5,
            urgency: 0.2,
            relevance: 0.5,
            expectedValue: 0.4,
            unfinishedWorkBonus: 0,
            resourceCost: 0.3,
            risk: 0.1,
          },
          context: {},
        },
      ];
    },
    () => [
      "Review recently stored episodic events",
      "Merge or discard low-value/duplicate entries",
      "Confirm durable facts are still accurate",
      "Record maintenance summary",
    ],
  ),
);

registerGoalDefinition(
  def(
    "KNOWLEDGE_ORGANIZATION",
    "Organize accumulated knowledge/notes",
    (ctx) => {
      const topics = (ctx.hints.knowledgeTopics as string[] | undefined) ?? [];
      if (topics.length === 0) return [];
      const last = mostRecent(ctx.recentObjectives, "KNOWLEDGE_ORGANIZATION");
      if (minutesSince(last?.updatedAt, ctx.now) < 60 * 24) return [];
      return [
        {
          category: "KNOWLEDGE_ORGANIZATION",
          title: "Organize knowledge base",
          rationale: "Knowledge topics due for organization.",
          factors: {
            priority: 0.25,
            usefulness: 0.5,
            urgency: 0.15,
            relevance: 0.5,
            expectedValue: 0.4,
            unfinishedWorkBonus: 0,
            resourceCost: 0.3,
            risk: 0.1,
          },
          context: { topics },
        },
      ];
    },
    () => [
      "Inventory current knowledge entries",
      "Group related entries and remove duplicates",
      "Fill gaps where structure is inconsistent",
      "Record the updated organization",
    ],
  ),
);

registerGoalDefinition(
  def(
    "SYSTEM_HEALTH",
    "Check core system health",
    (ctx) => {
      if (ctx.resource.freeMemPct >= 15 && ctx.resource.providerAvailable) {
        return [];
      }
      return [
        {
          category: "SYSTEM_HEALTH",
          title: "Investigate degraded system health",
          rationale: !ctx.resource.providerAvailable
            ? "No model/provider currently available."
            : `Free memory is low (${ctx.resource.freeMemPct}%).`,
          factors: {
            priority: 0.8,
            usefulness: 0.8,
            urgency: 0.7,
            relevance: 0.9,
            expectedValue: 0.7,
            unfinishedWorkBonus: 0,
            resourceCost: 0.2,
            risk: 0.15,
          },
          context: { freeMemPct: ctx.resource.freeMemPct },
        },
      ];
    },
    () => [
      "Assess CPU/RAM/provider/network state",
      "Identify the constrained resource",
      "Apply a safe mitigation (e.g. reduce concurrency)",
      "Verify the system has stabilized",
      "Record the incident",
    ],
  ),
);

registerGoalDefinition(
  def(
    "MODEL_HEALTH",
    "Verify configured model/provider availability",
    (ctx) => {
      if (ctx.resource.providerAvailable) return [];
      return [
        {
          category: "MODEL_HEALTH",
          title: "Diagnose unavailable model provider",
          rationale: "The active model/provider reported unavailable.",
          factors: {
            priority: 0.9,
            usefulness: 0.9,
            urgency: 0.9,
            relevance: 1,
            expectedValue: 0.8,
            unfinishedWorkBonus: 0,
            resourceCost: 0.2,
            risk: 0.1,
          },
          context: {},
        },
      ];
    },
    () => [
      "Check provider/network status",
      "Fall back to another configured provider or local model if possible",
      "Verify a test call succeeds",
      "Record the incident and resolution",
    ],
  ),
);

registerGoalDefinition(
  def(
    "RESOURCE_OPTIMIZATION",
    "Reduce resource waste in background work",
    (ctx) => {
      if (ctx.resource.activeTasks < ctx.resource.maxConcurrent) return [];
      return [
        {
          category: "RESOURCE_OPTIMIZATION",
          title: "Review saturated task concurrency",
          rationale: "Active tasks are at the concurrency ceiling.",
          factors: {
            priority: 0.4,
            usefulness: 0.5,
            urgency: 0.3,
            relevance: 0.6,
            expectedValue: 0.4,
            unfinishedWorkBonus: 0,
            resourceCost: 0.2,
            risk: 0.15,
          },
          context: {},
        },
      ];
    },
    () => [
      "Inspect currently running tasks",
      "Identify any stalled or low-value work to deprioritize",
      "Adjust concurrency or priorities if warranted",
      "Record the adjustment",
    ],
  ),
);

registerGoalDefinition(
  def(
    "PLANNING",
    "Plan the next block of autonomous work",
    (ctx) => {
      const hasAnyOtherWork =
        ctx.unfinishedObjectives.length > 0 ||
        Object.keys(ctx.hints).length > 0;
      if (hasAnyOtherWork) return [];
      return [
        {
          category: "PLANNING",
          title: "Plan next useful objectives",
          rationale:
            "No other candidate objectives available; plan ahead instead of idling.",
          factors: {
            priority: 0.2,
            usefulness: 0.4,
            urgency: 0.1,
            relevance: 0.4,
            expectedValue: 0.3,
            unfinishedWorkBonus: 0,
            resourceCost: 0.15,
            risk: 0.05,
          },
          context: {},
        },
      ];
    },
    () => [
      "Review project goals and prior objective history",
      "Draft a short list of candidate future objectives",
      "Store the list as context hints for future IDLE_DECISION cycles",
    ],
  ),
);

registerGoalDefinition(
  def(
    "EXPERIMENTATION",
    "Run a previously planned experiment",
    (ctx) => {
      const queue = (ctx.hints.experimentQueue as string[] | undefined) ?? [];
      if (queue.length === 0) return [];
      return [
        {
          category: "EXPERIMENTATION",
          title: `Run experiment: ${queue[0]}`,
          rationale: "A queued experiment has not been run yet.",
          factors: {
            priority: 0.3,
            usefulness: 0.6,
            urgency: 0.2,
            relevance: 0.6,
            expectedValue: 0.5,
            unfinishedWorkBonus: 0,
            resourceCost: 0.5,
            risk: 0.3,
          },
          context: { experiment: queue[0] },
        },
      ];
    },
    (c) => [
      `Set up the experiment: ${c.context?.experiment}`,
      "Run it in an isolated/safe manner",
      "Record the outcome",
      "Decide whether to adopt, discard, or iterate",
    ],
  ),
);

registerGoalDefinition(
  def(
    "DOCUMENTATION",
    "Document recently completed work that lacks docs",
    (ctx) => {
      const undocumented = ctx.recentObjectives.filter(
        (o) => o.status === "completed" && !(o.context?.documented === true),
      );
      if (undocumented.length === 0) return [];
      return [
        {
          category: "DOCUMENTATION",
          title: `Document ${undocumented.length} completed objective(s)`,
          rationale: "Completed work has no accompanying documentation.",
          factors: {
            priority: 0.25,
            usefulness: 0.6,
            urgency: 0.15,
            relevance: 0.5,
            expectedValue: 0.4,
            unfinishedWorkBonus: 0,
            resourceCost: 0.3,
            risk: 0.05,
          },
          context: { objectiveIds: undocumented.map((o) => o.id) },
        },
      ];
    },
    (c) => [
      `Review completed objectives: ${(c.context?.objectiveIds as string[] | undefined)?.join(", ")}`,
      "Write a concise summary of what changed and why",
      "Store the documentation where the project keeps it",
      "Mark the objective(s) as documented",
    ],
  ),
);

registerGoalDefinition(
  def(
    "AUTOMATION",
    "Automate a manually-repeated pattern",
    (ctx) => {
      const repeated =
        (ctx.hints.repeatedManualTasks as string[] | undefined) ?? [];
      if (repeated.length === 0) return [];
      return [
        {
          category: "AUTOMATION",
          title: `Automate: ${repeated[0]}`,
          rationale: "This task pattern has repeated manually multiple times.",
          factors: {
            priority: 0.35,
            usefulness: 0.7,
            urgency: 0.2,
            relevance: 0.6,
            expectedValue: 0.6,
            unfinishedWorkBonus: 0,
            resourceCost: 0.4,
            risk: 0.2,
          },
          context: { pattern: repeated[0] },
        },
      ];
    },
    (c) => [
      `Define the repeated pattern: ${c.context?.pattern}`,
      "Design an automation (scheduled task or script) for it",
      "Implement and test the automation",
      "Record it for future reuse",
    ],
  ),
);

registerGoalDefinition(
  def(
    "SELF_EVALUATION",
    "Review recent autonomous performance",
    (ctx) => {
      const last = mostRecent(ctx.recentObjectives, "SELF_EVALUATION");
      if (minutesSince(last?.updatedAt, ctx.now) < 60 * 24) return [];
      if (ctx.recentObjectives.length < 3) return [];
      return [
        {
          category: "SELF_EVALUATION",
          title: "Review recent autonomous performance",
          rationale:
            "Enough recent history to evaluate; no review in the last day.",
          factors: {
            priority: 0.2,
            usefulness: 0.5,
            urgency: 0.1,
            relevance: 0.5,
            expectedValue: 0.4,
            unfinishedWorkBonus: 0,
            resourceCost: 0.2,
            risk: 0.05,
          },
          context: {},
        },
      ];
    },
    () => [
      "Review completed vs failed objectives over the recent window",
      "Identify categories with a poor success rate",
      "Adjust scoring hints or plans for those categories",
      "Record the evaluation",
    ],
  ),
);

export const BUILTIN_GOAL_CATEGORIES: BuiltinGoalCategory[] = [
  "USER_FOLLOWUP",
  "UNFINISHED_WORK",
  "PROJECT_MAINTENANCE",
  "CODE_ANALYSIS",
  "TESTING",
  "BUG_INVESTIGATION",
  "RESEARCH",
  "LEARNING",
  "MEMORY_MAINTENANCE",
  "KNOWLEDGE_ORGANIZATION",
  "SYSTEM_HEALTH",
  "MODEL_HEALTH",
  "RESOURCE_OPTIMIZATION",
  "PLANNING",
  "EXPERIMENTATION",
  "DOCUMENTATION",
  "AUTOMATION",
  "SELF_EVALUATION",
];
