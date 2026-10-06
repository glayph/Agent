import { randomUUID } from "node:crypto";
import { errorMessage } from "./util.js";
function newPlanId() {
    return `plan_${randomUUID().slice(0, 8)}`;
}
function buildPlan(goal, source, complexity, steps) {
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
            status: "pending",
        })),
    };
}
/**
 * Internal error-state plan used only when the planning model is unavailable or
 * returns an unusable reply. It never inspects the goal's wording: the whole
 * goal becomes one step and the agent's own LLM loop decides what to do.
 */
export function fallbackPlan(goal) {
    return buildPlan(goal, "heuristic", "simple", [
        { title: goal.trim().slice(0, 160) || "Handle the request" },
    ]);
}
function parseComplexity(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start)
        return undefined;
    try {
        const value = JSON.parse(text.slice(start, end + 1))
            ?.complexity;
        return value === "trivial" || value === "simple" || value === "multi_step"
            ? value
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** Extract plan steps from a model reply; tolerant of code fences and prose around the JSON. */
export function parsePlanJson(text, knownTools, maxSteps = 6) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return null;
    }
    const rawSteps = parsed?.steps;
    if (!Array.isArray(rawSteps))
        return null;
    const steps = [];
    for (const item of rawSteps) {
        const entry = item;
        const title = typeof entry === "string"
            ? entry
            : typeof entry?.title === "string"
                ? entry.title
                : "";
        if (!title.trim())
            continue;
        const tool = typeof entry === "object" &&
            typeof entry.tool === "string" &&
            knownTools.has(entry.tool)
            ? entry.tool
            : undefined;
        const dependsOn = typeof entry === "object" && Array.isArray(entry.depends_on)
            ? entry.depends_on.filter((value) => Number.isInteger(value))
            : undefined;
        steps.push({
            title: title.trim().slice(0, 160),
            ...(tool ? { tool } : {}),
            ...(dependsOn?.length ? { dependsOn } : {}),
        });
        if (steps.length >= maxSteps)
            break;
    }
    return steps.length ? steps : null;
}
/**
 * Plans a goal. The model alone decides how many steps the request needs
 * (a single step for a simple request); only a planner failure falls back to
 * the minimal internal fallback plan.
 */
export async function createPlan(input) {
    if (!input.llm)
        return fallbackPlan(input.goal);
    const maxSteps = input.maxSteps ?? 6;
    try {
        const response = await input.llm.complete([
            {
                role: "system",
                content: `You are the planning module of an autonomous agent. Understand what the user actually wants, then break the goal into 1-${maxSteps} concrete steps and identify dependencies so independent work can run in parallel. Use a single step when the request needs only one action or a direct conversational answer. ` +
                    `Reply with ONLY a JSON object: {"steps":[{"title":"short imperative step","tool":"tool name or null","depends_on":[1,2]}]}. ` +
                    `depends_on uses 1-based step numbers and may be [] for an independent step. Do not invent dependencies; add one when the step needs another step's result. ` +
                    `Available tools: ${input.toolNames.join(", ") || "none"}. Use null when no tool is needed.`,
            },
            { role: "user", content: input.goal },
        ], { json: true, toolChoice: "none", signal: input.signal });
        const text = response.choices?.[0]?.message?.content;
        const steps = parsePlanJson(typeof text === "string" ? text : "", new Set(input.toolNames), maxSteps);
        if (steps && steps.length >= 1) {
            // If the model ignores depends_on entirely, prefer a safe sequential DAG
            // over accidentally parallelizing data-dependent work. Explicit [] still
            // means the step is independent and may run in parallel.
            const hasDependencyMetadata = steps.some((step) => step.dependsOn !== undefined);
            const normalizedSteps = !hasDependencyMetadata && steps.length > 1
                ? steps.map((step, index) => ({
                    ...step,
                    ...(index > 0 ? { dependsOn: [index] } : {}),
                }))
                : steps;
            const complexity = parseComplexity(typeof text === "string" ? text : "") ??
                (normalizedSteps.length > 1 ? "multi_step" : "simple");
            return buildPlan(input.goal, "llm", complexity, normalizedSteps);
        }
        input.onFallback?.("The planner reply did not contain valid steps.");
    }
    catch (error) {
        if (input.signal?.aborted)
            throw error;
        input.onFallback?.(errorMessage(error));
    }
    return fallbackPlan(input.goal);
}
export function describePlan(plan) {
    return plan.steps
        .map((step, index) => `${index + 1}. ${step.title}${step.tool ? ` (tool: ${step.tool})` : ""}${step.dependsOn?.length ? ` [after: ${step.dependsOn.join(", ")}]` : ""}`)
        .join("\n");
}
