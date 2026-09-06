/**
 * CostCalibrator — model-aware token-budget calibration layer.
 *
 * Different LLM providers charge vastly different prices per token.  A flat
 * max_tokens_per_cycle = 1000 is appropriate for GPT-4o (~$0.015/token) but
 * far too generous for free models and far too restrictive for cheaper ones.
 *
 * CostCalibrator converts a *nominal* token budget (defined in config) into a
 * *model-adjusted* effective budget, and also converts token usage into
 * "budget consumption" units for telemetry.
 */

// ── model cost data (mirrors MODEL_COST_PER_TOKEN from llm.ts) ─────────────

interface ModelCost {
  prompt: number; // USD per token
  completion: number; // USD per token
}

export const MODEL_COSTS: Record<string, ModelCost> = {
  "openai/gpt-4o": {
    prompt: 2.5 / 1_000_000,
    completion: 10 / 1_000_000,
  },
  "openai/gpt-4o-mini": {
    prompt: 0.15 / 1_000_000,
    completion: 0.6 / 1_000_000,
  },
  "openai/gpt-4o-2024-08-06": {
    prompt: 2.5 / 1_000_000,
    completion: 10 / 1_000_000,
  },
  "openai/gpt-4.1": {
    prompt: 2.0 / 1_000_000,
    completion: 8.0 / 1_000_000,
  },
  "openai/gpt-4.1-mini": {
    prompt: 0.4 / 1_000_000,
    completion: 1.6 / 1_000_000,
  },
  "openai/gpt-4.1-nano": {
    prompt: 0.1 / 1_000_000,
    completion: 0.4 / 1_000_000,
  },
  "openai/o3-mini": {
    prompt: 1.1 / 1_000_000,
    completion: 4.4 / 1_000_000,
  },
  "openai/o1": {
    prompt: 15 / 1_000_000,
    completion: 60 / 1_000_000,
  },
  "anthropic/claude-3.5-sonnet": {
    prompt: 3 / 1_000_000,
    completion: 15 / 1_000_000,
  },
  "anthropic/claude-3.7-sonnet": {
    prompt: 3 / 1_000_000,
    completion: 15 / 1_000_000,
  },
  "anthropic/claude-3-haiku": {
    prompt: 0.25 / 1_000_000,
    completion: 1.25 / 1_000_000,
  },
  "anthropic/claude-3-opus": {
    prompt: 15 / 1_000_000,
    completion: 75 / 1_000_000,
  },
  "google/gemini-2.0-flash-001": {
    prompt: 0.1 / 1_000_000,
    completion: 0.4 / 1_000_000,
  },
  "google/gemini-2.0-flash-lite-001": {
    prompt: 0.075 / 1_000_000,
    completion: 0.3 / 1_000_000,
  },
  "google/gemini-2.5-pro-exp-03-25": {
    prompt: 1.25 / 1_000_000,
    completion: 5.0 / 1_000_000,
  },
  "meta-llama/llama-3.3-70b-instruct": {
    prompt: 0.35 / 1_000_000,
    completion: 0.4 / 1_000_000,
  },
  "meta-llama/llama-4-scout-17b-16e-instruct": {
    prompt: 0.2 / 1_000_000,
    completion: 0.2 / 1_000_000,
  },
  "deepseek/deepseek-chat": {
    prompt: 0.27 / 1_000_000,
    completion: 1.1 / 1_000_000,
  },
  "deepseek/deepseek-r1": {
    prompt: 0.55 / 1_000_000,
    completion: 2.19 / 1_000_000,
  },
  "mistralai/mistral-large-2411": {
    prompt: 2.0 / 1_000_000,
    completion: 6.0 / 1_000_000,
  },
  "mistralai/mistral-saba-2502": {
    prompt: 0.2 / 1_000_000,
    completion: 0.2 / 1_000_000,
  },
  "cohere/command-r7b-12-2024": {
    prompt: 0.15 / 1_000_000,
    completion: 0.6 / 1_000_000,
  },
  "qwen/qwq-32b": {
    prompt: 0.35 / 1_000_000,
    completion: 0.4 / 1_000_000,
  },
  "qwen/qwen2.5-vl-72b-instruct": {
    prompt: 0.35 / 1_000_000,
    completion: 0.4 / 1_000_000,
  },
};

// ── budget multipliers ─────────────────────────────────────────────────────

/**
 * Multiplier applied on top of the cost-ratio adjustment.
 * Use Infinity for truly free / unlimited models.
 */
const MODEL_BUDGET_MULTIPLIERS: Record<string, number> = {
  "openai/gpt-4o": 1.0,
  "openai/gpt-4o-mini": 5.0,
  "openai/gpt-4o-2024-08-06": 1.0,
  "openai/gpt-4.1": 1.2,
  "openai/gpt-4.1-mini": 4.0,
  "openai/gpt-4.1-nano": 8.0,
  "openai/o3-mini": 1.0,
  "openai/o1": 0.5,
  "anthropic/claude-3.5-sonnet": 0.8,
  "anthropic/claude-3.7-sonnet": 0.8,
  "anthropic/claude-3-haiku": 5.0,
  "anthropic/claude-3-opus": 0.3,
  "google/gemini-2.0-flash-001": 3.0,
  "google/gemini-2.0-flash-lite-001": 5.0,
  "google/gemini-2.5-pro-exp-03-25": 0.8,
  "meta-llama/llama-3.3-70b-instruct": 2.0,
  "meta-llama/llama-4-scout-17b-16e-instruct": 3.0,
  "deepseek/deepseek-chat": 2.0,
  "deepseek/deepseek-r1": 1.0,
  "mistralai/mistral-large-2411": 1.0,
  "mistralai/mistral-saba-2502": 4.0,
  "cohere/command-r7b-12-2024": 3.0,
  "qwen/qwq-32b": 2.0,
  "qwen/qwen2.5-vl-72b-instruct": 2.0,
};

// Reference model — nominal budget is calibrated against GPT-4o pricing
const REFERENCE_MODEL = "openai/gpt-4o";

// ── helper ────────────────────────────────────────────────────────────────

function _lookupCosts(model: string): ModelCost | undefined {
  return MODEL_COSTS[model.replace(/^openrouter\//, "")];
}

function _lookupMultiplier(model: string): number | undefined {
  return MODEL_BUDGET_MULTIPLIERS[model.replace(/^openrouter\//, "")];
}

function _avgCost(model: string): number {
  const c = _lookupCosts(model);
  if (!c) return 0;
  return (c.prompt + c.completion) / 2;
}

// ── public API ─────────────────────────────────────────────────────────────

export class CostCalibrator {
  /**
   * Convert a nominal token budget (e.g. 1000 from agent.yaml) into an
   * effective budget for the given model, grounded in USD cost ratios.
   *
   * For free models (multiplier === Infinity) returns Infinity.
   * For unknown models returns the nominal budget.
   */
  static effectiveBudget(nominalBudget: number, model: string): number {
    const refAvg = _avgCost(REFERENCE_MODEL);
    if (refAvg === 0) return nominalBudget;

    const cost = _avgCost(model);
    const multiplier = _lookupMultiplier(model);
    if (cost === 0 && multiplier !== undefined)
      return multiplier === Infinity ? Infinity : nominalBudget;

    const ratio = cost > 0 ? refAvg / cost : 1;
    const result = Math.round(nominalBudget * ratio * (multiplier ?? 1));
    return Math.min(result, 50_000); // hard ceiling regardless of model
  }

  /**
   * Express actual token usage as "budget consumption" — the number of
   * nominal-budget tokens that the same spend would have consumed under the
   * reference (GPT-4o) pricing.
   *
   * Useful for heartbeat telemetry: `token_budget` field now reflects
   * actual budget *remaining*, not a flat constant.
   */
  static costInBudgetTokens(
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): number {
    const costs = _lookupCosts(model);
    const refCosts = _lookupCosts(REFERENCE_MODEL);
    if (!costs || !refCosts) return promptTokens + completionTokens;

    const thisCost =
      promptTokens * costs.prompt + completionTokens * costs.completion;
    const refAvgCost =
      ((refCosts.prompt + refCosts.completion) / 2) *
      (promptTokens + completionTokens);
    if (refAvgCost === 0) return promptTokens + completionTokens;

    return Math.round(
      (thisCost / refAvgCost) * (promptTokens + completionTokens),
    );
  }
}
