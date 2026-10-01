import type { LLMResponse } from "@miki/config";
import { MODEL_COSTS } from "./cost-calibrator.js";
import { providerRegistry } from "./llm/provider/registry.js";
import { getDirectProviderById } from "./llm/provider/catalog.js";
import { getDefaultModelRouter } from "./llm/model-router/index.js";
import type { MikiProviderMessage } from "./llm/provider/sdk/index.js";

/**
 * Backward-compatible provider name used by existing agent configuration.
 * New provider implementations belong under `./plugins/providers/`; shared
 * contracts and registry remain under `./llm/provider/`.
 */
export type Provider = "gemini" | "llama.cpp";

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
 * Backward-compatible completion entrypoint. It is a thin wrapper over the
 * process-wide {@link ModelRouter}: the router is the ONLY component that calls
 * a provider, so lane profiles, failover, credential rotation and hop logging
 * apply here exactly as they do for the agent loop.
 *
 * `modelOverride` is an explicit model choice and therefore strict (no silent
 * fallback). Without it the `default` lane (or `route.lane`) decides.
 */
export async function achatCompletion(
  messages: MikiProviderMessage[],
  extra?: Record<string, unknown>,
  modelOverride?: string,
  signal?: AbortSignal,
  route: { lane?: string; role?: string } = {},
): Promise<LLMResponse> {
  const result = await getDefaultModelRouter().complete({
    lane: route.lane,
    role: route.role,
    explicitModel: modelOverride?.trim() || undefined,
    messages,
    extra,
    signal,
  });
  return result.response;
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
  const normalized = model.replace(/^(?:gemini|google)\//i, "");
  const candidates = [
    model,
    normalized,
    normalized.replace(/^gemini\//i, "google/"),
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
