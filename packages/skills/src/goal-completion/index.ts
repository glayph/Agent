/**
 * Goal Completion Skill
 *
 * This skill provides goal-based task execution and progress tracking.
 * It delegates execution to the core goal system through a stable tool contract.
 */

export interface SkillToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type SkillToolHandler = (
  args: Record<string, unknown>,
) => Promise<string> | string;

export type SkillToolRegistrar = (
  name: string,
  handler: SkillToolHandler,
  definition: SkillToolDefinition,
) => void;

export const goalCompletionSkill = {
  name: "goal-completion",
  version: "1.0.0",
  description:
    "Goal completion: validate and start a tracked goal with optional ordered steps",

  async execute(params: {
    objective: string;
    steps?: string[];
    context?: Record<string, unknown>;
  }) {
    const objective =
      typeof params.objective === "string" ? params.objective.trim() : "";
    if (!objective) {
      return {
        success: false,
        message: "An objective is required to start goal execution.",
      };
    }

    const steps = Array.isArray(params.steps)
      ? params.steps
          .filter((step): step is string => typeof step === "string")
          .map((step) => step.trim())
          .filter(Boolean)
      : [];

    return {
      success: true,
      message: "Goal execution accepted by the goal-completion skill.",
      objective,
      steps,
      context: params.context || {},
    };
  },
};

/** Register the skill as a callable ToolRegistry function. */
export function registerSkills(register: SkillToolRegistrar): void {
  register(
    "goal_completion",
    async (args) => {
      const result = await goalCompletionSkill.execute({
        objective: typeof args.objective === "string" ? args.objective : "",
        steps: Array.isArray(args.steps) ? args.steps : undefined,
        context:
          args.context &&
          typeof args.context === "object" &&
          !Array.isArray(args.context)
            ? (args.context as Record<string, unknown>)
            : undefined,
      });
      return JSON.stringify(result);
    },
    {
      type: "function",
      function: {
        name: "goal_completion",
        description:
          "Validate and start a tracked goal with an objective and optional ordered steps.",
        parameters: {
          type: "object",
          properties: {
            objective: { type: "string", description: "The goal to pursue." },
            steps: {
              type: "array",
              items: { type: "string" },
              description: "Optional ordered execution steps.",
            },
            context: {
              type: "object",
              additionalProperties: true,
              description: "Optional goal context.",
            },
          },
          required: ["objective"],
          additionalProperties: false,
        },
      },
    },
  );
}

export default goalCompletionSkill;
