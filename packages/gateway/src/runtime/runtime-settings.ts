import { TokenBudgetManager } from "@miki/core/token-budget-manager";

const budgetManager = new TokenBudgetManager();

/** Runtime defaults mirrored from the Settings form so an unset config value
 * has the same effective behavior as the UI's default state. */
export const DEFAULT_UNKNOWN_MODEL_CONTEXT_ESTIMATE_TOKENS = 32768;
export const DEFAULT_MAX_TOOL_ITERATIONS = Number.POSITIVE_INFINITY;
export const DEFAULT_MAX_WALL_TIME_MS = 0;
export const DEFAULT_TOOL_TIMEOUT_MS = 0;
export const DEFAULT_CHAT_QUEUE_WAIT_MS = 0;
/** Task lifetime/inactivity limits are disabled: runs continue until completion or explicit cancellation. */
export const DEFAULT_CHAT_INACTIVITY_TIMEOUT_MS = 0;

function positiveInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

/** A configured zero intentionally disables argument preview truncation. */
export function resolveToolFeedbackMaxArgsLength(value: unknown, fallback = 300): number {
  if (value === 0 || value === "0") return 0
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return fallback
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback
}

export function resolveMaxToolIterations(_defaults: Record<string, unknown>, _env: NodeJS.ProcessEnv = process.env): number {
  // Legacy iteration settings and environment variables must not reactivate an
  // arbitrary stop condition. Resource controls remain enforced independently.
  return Number.POSITIVE_INFINITY;
}

export function resolveMaxWallTimeMs(_defaults: Record<string, unknown>, _env: NodeJS.ProcessEnv = process.env): number {
  // Legacy config/environment values cannot reactivate a goal/run lifetime cap.
  // Explicit per-tool/provider timeouts remain separate failure-detection policies.
  return DEFAULT_MAX_WALL_TIME_MS;
}

/** No generic tool deadline. Individual tools own adaptive, renewable leases. */
export function resolveToolTimeoutMs(_defaults: Record<string, unknown>, _env: NodeJS.ProcessEnv = process.env): number {
  return DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * A conversation lane remains serialized until its holder releases it. Zero means
 * wait without an arbitrary deadline; cancellation is controlled by the caller's signal.
 */
export function resolveChatQueueWaitMs(
  defaults: Record<string, unknown>,
  _runWallTimeMs: number,
  _env: NodeJS.ProcessEnv = process.env,
): number {
  // Session lanes wait until release or explicit owner cancellation; legacy timeout settings are ignored.
  return DEFAULT_CHAT_QUEUE_WAIT_MS;
}

/**
 * Miki's task lifetime is intentionally unbounded. Idle time is diagnostic only;
 * it must never cancel a long-running model/tool operation. Legacy config and
 * environment values are ignored so an old setting cannot reintroduce a stop.
 */
export function resolveChatInactivityTimeoutMs(
  _defaults: Record<string, unknown>,
  _env: NodeJS.ProcessEnv = process.env,
): number {
  return 0;
}

/** Background tasks follow the same unlimited-lifetime policy as foreground chat. */
export function resolveBackgroundTaskInactivityTimeoutMs(
  _defaults: Record<string, unknown>,
  _env: NodeJS.ProcessEnv = process.env,
): number {
  return 0;
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
 * and only without a known model an estimate derived from the configured completion-reserve hint.
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
  const completionHintTokens = positiveInteger(defaults.max_completion_tokens ?? defaults.max_tokens) ?? DEFAULT_UNKNOWN_MODEL_CONTEXT_ESTIMATE_TOKENS;
  const real = modelName ? lookup(modelName) : undefined;
  // Only when the model is unknown: a window guess of 4x the completion hint. This is a token-to-token
  // ratio, not a text conversion, so it is independent of script and is intentionally not language-aware.
  const resolved = real ?? completionHintTokens * 4;
  return cap === undefined ? resolved : Math.min(resolved, cap);
}
