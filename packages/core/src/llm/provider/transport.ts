import OpenAI from "openai";

export interface ProviderTransportConfig {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv?: string;
  emptyApiKeyAllowed: boolean;
  local?: boolean;
}

export function providerClient(
  provider: ProviderTransportConfig,
  apiKey: string,
  timeoutMs?: number,
): OpenAI {
  const effectiveKey =
    apiKey || (provider.emptyApiKeyAllowed ? "local-no-auth-required" : apiKey);
  return new OpenAI({
    baseURL: provider.baseUrl,
    apiKey: effectiveKey,
    timeout: timeoutMs ?? (provider.local ? 90_000 : 120_000),
    maxRetries: 0,
  });
}
