import {
  resolveEnvSecret,
  setEnvSecret,
  settings,
} from "@hiro/config";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnvVar: string;
  models: string[];
  isActive: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  costPer1kTokens?: {
    input: number;
    output: number;
  };
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    models: [
      "anthropic/claude-3.5-sonnet",
      "anthropic/claude-3.5-haiku",
      "openai/gpt-4-turbo",
      "openai/gpt-4o",
      "google/gemini-2.0-flash",
      "meta-llama/llama-3.1-405b",
    ],
    isActive: false,
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnvVar: "GEMINI_API_KEY",
    models: ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
    isActive: false,
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY",
    models: ["gpt-4-turbo", "gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
    isActive: false,
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    models: [
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
    ],
    isActive: false,
  },
};

export function getAvailableProviders(): ProviderConfig[] {
  return Object.values(PROVIDER_CONFIGS).map((provider) => ({
    ...provider,
    isActive: isProviderConfigured(provider.id),
  }));
}

export function getProviderById(id: string): ProviderConfig | null {
  const provider = PROVIDER_CONFIGS[id];
  if (!provider) return null;
  return {
    ...provider,
    isActive: isProviderConfigured(id),
  };
}

export function isProviderConfigured(providerId: string): boolean {
  const provider = PROVIDER_CONFIGS[providerId];
  if (!provider) return false;
  const apiKey = resolveEnvSecret(provider.apiKeyEnvVar);
  return !!apiKey && apiKey.length > 0;
}

export function getConfiguredProviders(): ProviderConfig[] {
  return getAvailableProviders().filter((p) => p.isActive);
}

export function getActiveProvider(): ProviderConfig | null {
  const currentModel = settings.defaultModel;

  // Determine provider from model name
  if (currentModel.startsWith("anthropic/")) {
    return getProviderById("openrouter");
  }
  if (
    currentModel.startsWith("gemini/") ||
    currentModel.startsWith("google/")
  ) {
    return getProviderById("gemini");
  }
  if (currentModel.startsWith("openai/")) {
    return getProviderById("openai");
  }

  // Default to openrouter
  return getProviderById("openrouter");
}

export function getModelsByProvider(providerId: string): ModelInfo[] {
  const provider = getProviderById(providerId);
  if (!provider) return [];

  return provider.models.map((modelName) => ({
    id: `${providerId}/${modelName}`,
    name: modelName,
    provider: providerId,
  }));
}

export function getAllModels(): ModelInfo[] {
  const allModels: ModelInfo[] = [];
  for (const provider of getAvailableProviders()) {
    allModels.push(...getModelsByProvider(provider.id));
  }
  return allModels;
}

export function setProviderApiKey(providerId: string, apiKey: string): boolean {
  const provider = PROVIDER_CONFIGS[providerId];
  if (!provider) return false;

  setEnvSecret(provider.apiKeyEnvVar, apiKey);
  return true;
}

export function getProviderApiKey(providerId: string): string {
  const provider = PROVIDER_CONFIGS[providerId];
  if (!provider) return "";
  return resolveEnvSecret(provider.apiKeyEnvVar);
}
