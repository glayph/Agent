import type { LLMResponse } from "@miki/config";
import { MODEL_COSTS } from "./cost-calibrator.js";
import { providerRegistry } from "./llm/provider/registry.js";
import { getDirectProviderById } from "./llm/provider/catalog.js";
import type { MikiProviderMessage } from "./llm/provider/sdk/index.js";

/**
 * Backward-compatible provider name used by existing agent configuration.
 * New provider implementations belong under `./llm/provider/`.
 */
export type Provider = "gemini" | "openai" | "openrouter";

export {
  LLMProviderError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMAPIError,
  LLMEntitlementError,
  LLMMissingCredentialError,
  LiteLLMError,
  LiteLLMRateLimitError,
  LiteLLMTimeoutError,
  LiteLLMAPIError,
  LiteLLMMissingCredentialError,
} from "./llm/provider/errors.js";

/**
 * Single stable completion entrypoint for the agent runtime.
 *
 * Provider selection, credential lookup, SDK calls, retries, and error
 * normalization are delegated to the isolated provider registry. Agent code
 * therefore does not change when a provider adapter is added or replaced.
 */
export async function achatCompletion(
  messages: MikiProviderMessage[],
  extra?: Record<string, unknown>,
): Promise<LLMResponse> {
  const model = (await import("@miki/config")).settings.defaultModel;
  return providerRegistry.complete(model, messages, extra);
}

export async function supportsAudioModel(
  model: string,
): Promise<boolean | undefined> {
  return providerRegistry.supportsAudio(model);
}

/** Clear all provider SDK client caches after credentials or endpoints change. */
export function updateClient(): void {
  providerRegistry.clearCaches();
}

export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const normalized = model.replace(/^openrouter\//, "");
  const candidates = [
    model,
    normalized,
    normalized.replace(/^gemini\//, "google/"),
  ];
  const costs = candidates
    .map((candidate) => MODEL_COSTS[candidate])
    .find(Boolean);

  if (!costs) return 0;
  return Number(
    (promptTokens * costs.prompt + completionTokens * costs.completion).toFixed(
      8,
    ),
  );
}

/** Compatibility export retained for launcher/model-management code. */
export function getDirectProviderByIdPublic(id: string) {
  return getDirectProviderById(id);
}
