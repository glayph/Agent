import { createOpenAICompatibleProvider } from "./openai-compatible-factory.js";

export const openAIProviderPlugin = createOpenAICompatibleProvider({
  id: "openai",
  displayName: "OpenAI",
  aliases: ["gpt", "chatgpt"],
  modelPrefixes: ["gpt", "o1", "o3", "o4"],
  apiKeyEnv: "OPENAI_API_KEY",
  defaultBaseUrl: "https://api.openai.com/v1",
  iconSlug: "openai",
  domain: "platform.openai.com",
  priority: 90,
  description: "OpenAI official API through the Miki Provider Gateway.",
});

export const openAICompatibleProviderPlugin = createOpenAICompatibleProvider({
  id: "openai-compatible",
  displayName: "OpenAI Compatible",
  aliases: ["compatible", "openai_compatible"],
  modelPrefixes: ["compatible", "local"],
  apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
  defaultBaseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL || "http://127.0.0.1:8000/v1",
  iconSlug: "openai",
  domain: "",
  priority: 70,
  description: "Any server implementing the OpenAI chat-completions contract.",
  allowEmptyKey: true,
});

export const openRouterProviderPlugin = createOpenAICompatibleProvider({
  id: "openrouter",
  displayName: "OpenRouter",
  aliases: ["open-router"],
  modelPrefixes: ["openrouter"],
  apiKeyEnv: "OPENROUTER_API_KEY",
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  iconSlug: "openrouter",
  domain: "openrouter.ai",
  priority: 80,
  description: "OpenRouter multi-model routing through an OpenAI-compatible API.",
});
