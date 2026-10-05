import { randomUUID } from "node:crypto";
import type {
  AgentPlan,
  EngineLLMClient,
  PlanStep,
} from "./types.js";
import { errorMessage } from "./util.js";

export interface GoalAnalysis {
  complexity: AgentPlan["complexity"];
  /** Words in the goal that indicate real work (English and Bengali). */
  markers: string[];
}

const ACTION_EN =
  /\b(file|folder|directory|workspace|read|write|create|edit|delete|rename|move|copy|list|find|search|grep|run|execute|check|inspect|analy[sz]e|investigate|debug|fix|install|configure|config|setting|enable|disable|model|tool|memory|remember|summari[sz]e|compare|diagnos\w*|verify|audit|refactor|implement|build|test)\b/gi;
const ACTION_BN =
  /(ফাইল|ফোল্ডার|পড়|লিখ|তৈরি|খুঁজ|অনুসন্ধান|চালা|চেক|যাচাই|বিশ্লেষণ|সমস্যা|সমাধান|ঠিক কর|কনফিগার|সেটিং|চালু|বন্ধ|মডেল|টুল|মনে রাখ|তুলনা|ধাপ|পরিকল্পনা)/g;
const SEQUENCE =
  /\b(and then|then|after that|afterwards|first|next|finally)\b|তারপর|এরপর|প্রথমে|শেষে|অতঃপর/i;

/** Cheap, offline classification used to decide whether a plan is worth an LLM call. */
export function analyzeGoal(goal: string): GoalAnalysis {
  const text = goal.trim();
  const markers = [
    ...new Set(
      [...(text.match(ACTION_EN) ?? []), ...(text.match(ACTION_BN) ?? [])].map(
        (item) => item.toLowerCase(),
      ),
    ),
  ];
  const words = text.split(/\s+/).filter(Boolean).length;
  if (markers.length === 0 && words <= 12)
    return { complexity: "trivial", markers };
  const sequenced = SEQUENCE.test(text);
  // Several marker words alone ("read the config file") are still one action;
  // multi-step needs explicit sequencing, a very long request, or many distinct actions.
  if ((sequenced && markers.length >= 2) || markers.length >= 6 || text.length > 300)
    return { complexity: "multi_step", markers };
  return { complexity: "simple", markers };
}

function newPlanId(): string {
  return `plan_${randomUUID().slice(0, 8)}`;
}

function buildPlan(
  goal: string,
  source: AgentPlan["source"],
  complexity: AgentPlan["complexity"],
  steps: Array<{ title: string; tool?: string; dependsOn?: number[] }>,
): AgentPlan {
  return {
    id: newPlanId(),
    goal,
    source,
    complexity,
    createdAt: new Date().toISOString(),
    steps: steps.map((step, index) => ({
      id: `s${index + 1}`,
      title: step.title,
      ...(step.tool ? { tool: step.tool } : {}),
      ...(step.dependsOn?.length
        ? {
            dependsOn: step.dependsOn
              .filter((dep) => Number.isInteger(dep) && dep >= 1 && dep <= index)
              .map((dep) => `s${dep}`),
          }
        : {}),
      status: "pending" as const,
    })),
  };
}

/** Split the goal text on sequencing words; always yields at least one step. */
export function heuristicPlan(goal: string, analysis = analyzeGoal(goal)): AgentPlan {
  if (analysis.complexity === "trivial")
    return buildPlan(goal, "none", "trivial", [{ title: "Answer directly" }]);
  const parts = goal
    .split(
      /\s*(?:\band then\b|\bthen\b|\bafter that\b|\bafterwards\b|,\s*(?=and\b)|;|\.\s+|তারপর|এরপর|অতঃপর)\s*/i,
    )
    .map((part) => part.trim().replace(/^(and|first|next|finally)\s+/i, ""))
    .filter((part) => part.length > 2)
    .slice(0, 6);
  const titles = parts.length > 1 ? parts : [goal.trim().slice(0, 160)];
  return buildPlan(
    goal,
    "heuristic",
    analysis.complexity,
    titles.map((title, index) => ({
      title: title.slice(0, 160),
      ...(index > 0 ? { dependsOn: [index] } : {}),
    })),
  );
}

/** Extract plan steps from a model reply; tolerant of code fences and prose around the JSON. */
export function parsePlanJson(
  text: string,
  knownTools: ReadonlySet<string>,
  maxSteps = 6,
): Array<{ title: string; tool?: string; dependsOn?: number[] }> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const rawSteps = (parsed as { steps?: unknown })?.steps;
  if (!Array.isArray(rawSteps)) return null;
  const steps: Array<{ title: string; tool?: string; dependsOn?: number[] }> = [];
  for (const item of rawSteps) {
    const entry = item as { title?: unknown; tool?: unknown; depends_on?: unknown } | string;
    const title =
      typeof entry === "string"
        ? entry
        : typeof entry?.title === "string"
          ? entry.title
          : "";
    if (!title.trim()) continue;
    const tool =
      typeof entry === "object" &&
      typeof entry.tool === "string" &&
      knownTools.has(entry.tool)
        ? entry.tool
        : undefined;
    const dependsOn =
      typeof entry === "object" && Array.isArray(entry.depends_on)
        ? entry.depends_on.filter((value): value is number => Number.isInteger(value))
        : undefined;
    steps.push({
      title: title.trim().slice(0, 160),
      ...(tool ? { tool } : {}),
      ...(dependsOn?.length ? { dependsOn } : {}),
    });
    if (steps.length >= maxSteps) break;
  }
  return steps.length ? steps : null;
}

export interface CreatePlanInput {
  goal: string;
  llm?: EngineLLMClient;
  toolNames: string[];
  signal?: AbortSignal;
  maxSteps?: number;
  /** Called when the LLM planner fails and the heuristic plan is used instead. */
  onFallback?: (reason: string) => void;
}

/**
 * Plans a goal. Multi-step goals are decomposed by the model; everything else,
 * and every planner failure, falls back to a deterministic heuristic plan.
 */
export async function createPlan(input: CreatePlanInput): Promise<AgentPlan> {
  const analysis = analyzeGoal(input.goal);
  if (analysis.complexity !== "multi_step" || !input.llm)
    return heuristicPlan(input.goal, analysis);

  const maxSteps = input.maxSteps ?? 6;
  try {
    const response = await input.llm.complete(
      [
        {
          role: "system",
          content:
            `You are the planning module of an autonomous agent. Break the user's goal into 2-${maxSteps} concrete steps and identify dependencies so independent work can run in parallel. ` +
            `Reply with ONLY a JSON object: {"steps":[{"title":"short imperative step","tool":"tool name or null","depends_on":[1,2]}]}. ` +
            `depends_on uses 1-based step numbers and may be [] for an independent step. Do not invent dependencies; add one when the step needs another step's result. ` +
            `Available tools: ${input.toolNames.join(", ") || "none"}. Use null when no tool is needed.`,
        },
        { role: "user", content: input.goal },
      ],
      { json: true, toolChoice: "none", signal: input.signal },
    );
    const text = response.choices?.[0]?.message?.content;
    const steps = parsePlanJson(
      typeof text === "string" ? text : "",
      new Set(input.toolNames),
      maxSteps,
    );
    if (steps && steps.length >= 1) {
      // If the model ignores depends_on entirely, prefer a safe sequential DAG
      // over accidentally parallelizing data-dependent work. Explicit [] still
      // means the step is independent and may run in parallel.
      const hasDependencyMetadata = steps.some((step) => step.dependsOn !== undefined);
      const normalizedSteps =
        !hasDependencyMetadata && steps.length > 1
          ? steps.map((step, index) => ({
              ...step,
              ...(index > 0 ? { dependsOn: [index] } : {}),
            }))
          : steps;
      return buildPlan(input.goal, "llm", analysis.complexity, normalizedSteps);
    }
    input.onFallback?.("The planner reply did not contain valid steps.");
  } catch (error) {
    if (input.signal?.aborted) throw error;
    input.onFallback?.(errorMessage(error));
  }
  return heuristicPlan(input.goal, analysis);
}

export function describePlan(plan: AgentPlan): string {
  return plan.steps
    .map(
      (step, index) =>
        `${index + 1}. ${step.title}${step.tool ? ` (tool: ${step.tool})` : ""}${step.dependsOn?.length ? ` [after: ${step.dependsOn.join(", ")}]` : ""}`,
    )
    .join("\n");
}

export type { PlanStep };
