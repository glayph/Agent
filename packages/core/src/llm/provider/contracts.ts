import type OpenAI from "openai";
import type { LLMResponse } from "@miki/config";
import type { ProviderTransportConfig } from "./transport.js";

export type ProviderMessage =
  OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface ProviderCompletionRequest {
  provider: ProviderTransportConfig;
  model: string;
  apiKey: string;
  messages: ProviderMessage[];
  extra?: Record<string, unknown>;
  /** Bounded request timeout in milliseconds; local models may need a longer CPU window. */
  timeoutMs?: number;
}

export interface ProviderModel {
  id: string;
  owned_by?: string;
}

/**
 * Adapter port. Implementations own all vendor SDK imports and error mapping.
 * The rest of core must depend on this interface, never on a vendor client.
 */
export interface LLMProviderAdapter {
  readonly providerId: string;
  complete(request: ProviderCompletionRequest): Promise<LLMResponse>;
  listModels?(
    provider: ProviderTransportConfig,
    apiKey: string,
    timeoutMs?: number,
  ): Promise<ProviderModel[]>;
  testConnection?(
    provider: ProviderTransportConfig,
    apiKey: string,
    timeoutMs?: number,
  ): Promise<ProviderConnectionResult>;
  clearCache?(): void;
}

export interface ProviderConnectionResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}
