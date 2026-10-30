import { TokenBudgetManager } from "@miki/core/token-budget-manager";

const budgetManager = new TokenBudgetManager();

/** Runtime defaults mirrored from the Settings form so an unset config value
 * has the same effective behavior as the UI's default state. */
export const DEFAULT_MAX_COMPLETION_TOKENS = 32768;
export const DEFAULT_MAX_TOOL_ITERATIONS = 50;
export const DEFAULT_MAX_WALL_TIME_MS = 300_000;

function positiveInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : undefined;
}

/** A configured zero intentionally disables argument preview truncation. */
export function resolveToolFeedbackMaxArgsLength(value: unknown, fallback = 300): number {
  if (value === 0 || value === "0") return 0
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return fallback
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback
}

export function resolveMaxToolIterations(defaults: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(defaults.max_tool_iterations)
    ?? positiveInteger(env.MIKI_AGENT_MAX_TURNS)
    ?? DEFAULT_MAX_TOOL_ITERATIONS;
}

export function resolveMaxWallTimeMs(defaults: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeInteger(defaults.max_wall_time_ms)
    ?? nonNegativeInteger(env.MIKI_AGENT_MAX_WALL_TIME_MS)
    ?? DEFAULT_MAX_WALL_TIME_MS;
}

/** Real context window of a model, or undefined when the model is unknown. Injected so tests stay pure. */
export type ModelContextLookup = (model: string) => number | undefined;

const defaultModelContextLookup: ModelContextLookup = (model) => {
  try {
    return positiveInteger(budgetManager.getModelLimits(model).contextWindowTokens);
  } catch {
    return undefined;
  }
};

/**
 * Order: explicit `context_window` (> 0), then the real window of the active model,
 * and only without a known model the legacy 4x max-completion-tokens estimate.
 */
export function resolveContextWindowTokens(
  defaults: Record<string, unknown>,
  model?: string,
  lookup: ModelContextLookup = defaultModelContextLookup,
): number | undefined {
  const explicit = positiveInteger(defaults.context_window);
  // A positive explicit value is an intentional override. Otherwise, very large
  // provider windows can make ordinary chat prompts grow unnecessarily and slow
  // every request; an optional cap bounds the working context without changing
  // the stored conversation or its searchable memory.
  if (explicit !== undefined) return explicit;
  const cap = positiveInteger(defaults.context_window_cap);
  const modelName = typeof model === "string" ? model.trim() : "";
  const maxTokens = positiveInteger(defaults.max_completion_tokens ?? defaults.max_tokens) ?? DEFAULT_MAX_COMPLETION_TOKENS;
  const real = modelName ? lookup(modelName) : undefined;
  const resolved = real ?? maxTokens * 4;
  return cap === undefined ? resolved : Math.min(resolved, cap);
}
