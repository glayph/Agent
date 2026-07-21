import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import {
  getRequiredEnvSecret,
  resolveLiteLLMMasterKey,
} from "@hiro/config/security";
import { type RuntimePaths } from "./paths.js";

export interface LiteLLMStoredModel {
  model_name: string;
  provider?: string;
  model?: string;
  api_base?: string;
  enabled?: boolean;
}

export interface LiteLLMProviderOption {
  id: string;
  default_api_base: string;
  empty_api_key_allowed: boolean;
}

export interface LiteLLMConfigResult {
  configPath: string;
  baseUrl: string;
  models: Array<{
    modelName: string;
    litellmModel: string;
    provider: string;
  }>;
}

interface LiteLLMModelEntry {
  model_name: string;
  litellm_params: Record<string, unknown>;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:4000/v1";
const WEAK_LITELLM_MASTER_KEYS = ["sk-anything"];

export function litellmBaseUrlFromEnv(): string {
  return process.env["LITELLM_BASE_URL"] || DEFAULT_BASE_URL;
}

export function requiredLiteLLMMasterKey(): string {
  return getRequiredEnvSecret("LITELLM_MASTER_KEY", {
    weakValues: WEAK_LITELLM_MASTER_KEYS,
    minLength: 12,
    label: "LITELLM_MASTER_KEY",
  });
}

export function litellmConfigPath(paths: RuntimePaths): string {
  const configured = process.env["LITELLM_CONFIG_PATH"];
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(paths.sourceDir ?? paths.configDir, configured);
  }
  return path.join(paths.configDir, "litellm.yaml");
}

export function litellmModelAliases(modelName: string): string[] {
  const aliases = [modelName];
  if (modelName.startsWith("google/")) {
    aliases.push(modelName.replace(/^google\//, "gemini/"));
  }
  return Array.from(new Set(aliases));
}

export function toLiteLLMProviderModel(
  provider: string,
  modelName: string,
  modelBody: string,
): string {
  const model = modelBody || modelName;
  const lowerModelName = modelName.toLowerCase();
  const openRouterModelPrefixes = [
    "meta-llama/",
    "mistralai/",
    "qwen/",
    "x-ai/",
    "cohere/",
    "perplexity/",
    "nousresearch/",
  ];
  if (
    openRouterModelPrefixes.some((prefix) => lowerModelName.startsWith(prefix))
  ) {
    return modelName.startsWith("openrouter/")
      ? modelName
      : `openrouter/${modelName}`;
  }
  switch (provider) {
    case "google":
    case "gemini":
      return model.startsWith("gemini/") ? model : `gemini/${model}`;
    case "openai":
      return model.startsWith("openai/") ? model : `openai/${model}`;
    case "anthropic":
      return model.startsWith("anthropic/") ? model : `anthropic/${model}`;
    case "openrouter":
      return model.startsWith("openrouter/") ? model : `openrouter/${model}`;
    case "deepseek":
      return model.startsWith("deepseek/") ? model : `deepseek/${model}`;
    case "ollama":
      return model.startsWith("ollama/") ? model : `ollama/${model}`;
    case "azure":
      return model.startsWith("azure/") ? model : `azure/${model}`;
    case "vllm":
    case "lmstudio":
      return model.startsWith("openai/") ? model : `openai/${model}`;
    default:
      return model;
  }
}

export function apiKeyEnvForLiteLLMProvider(provider: string): string | null {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "google":
    case "gemini":
      return "GEMINI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "azure":
      return "AZURE_OPENAI_API_KEY";
    default:
      return null;
  }
}

function modelBodyName(modelName: string, provider: string): string {
  const prefix = `${provider}/`;
  if (modelName.startsWith(prefix)) return modelName.slice(prefix.length);
  if (provider === "google" && modelName.startsWith("gemini/")) {
    return modelName.slice("gemini/".length);
  }
  if (provider === "openrouter") return modelName;
  const slash = modelName.indexOf("/");
  return slash > 0 ? modelName.slice(slash + 1) : modelName;
}

function normalizeLiteLLMProvider(provider: string, modelName: string): string {
  const raw = provider.trim().toLowerCase();
  const name = modelName.toLowerCase();
  const openRouterModelPrefixes = [
    "meta-llama/",
    "mistralai/",
    "qwen/",
    "x-ai/",
    "cohere/",
    "perplexity/",
    "nousresearch/",
  ];
  if (openRouterModelPrefixes.some((prefix) => name.startsWith(prefix))) {
    return "openrouter";
  }
  if (raw === "gemini") return "google";
  if (raw) return raw;
  if (name.startsWith("openai/")) return "openai";
  if (name.startsWith("anthropic/") || name.startsWith("claude")) {
    return "anthropic";
  }
  if (name.startsWith("google/") || name.startsWith("gemini/")) {
    return "google";
  }
  if (name.startsWith("deepseek/")) return "deepseek";
  if (name.startsWith("ollama/")) return "ollama";
  return name.includes("/") ? "openrouter" : "openrouter";
}

export function buildLiteLLMConfig(
  models: LiteLLMStoredModel[],
  providerOptions: LiteLLMProviderOption[],
): {
  config: Record<string, unknown>;
  mappedModels: LiteLLMConfigResult["models"];
} {
  const providerMap = new Map(providerOptions.map((item) => [item.id, item]));
  const entries: LiteLLMModelEntry[] = [];
  const mappedModels: LiteLLMConfigResult["models"] = [];
  const seenAliases = new Set<string>();

  for (const item of models) {
    if (item.enabled === false || !item.model_name) continue;
    const rawProvider = (item.provider || "").toLowerCase();
    const provider = normalizeLiteLLMProvider(rawProvider, item.model_name);
    const option = providerMap.get(provider);
    const modelBody =
      rawProvider && provider !== rawProvider
        ? modelBodyName(item.model_name, provider)
        : item.model || modelBodyName(item.model_name, provider);
    const litellmModel = toLiteLLMProviderModel(
      provider,
      item.model_name,
      modelBody,
    );
    const params: Record<string, unknown> = { model: litellmModel };
    const apiKeyEnv = apiKeyEnvForLiteLLMProvider(provider);

    if (apiKeyEnv && !option?.empty_api_key_allowed) {
      params.api_key = `os.environ/${apiKeyEnv}`;
    }
    if (
      item.api_base &&
      provider !== "google" &&
      provider !== "gemini" &&
      (option?.empty_api_key_allowed ||
        provider === "vllm" ||
        provider === "lmstudio" ||
        item.api_base !== option?.default_api_base)
    ) {
      params.api_base = item.api_base;
    }

    for (const alias of litellmModelAliases(item.model_name)) {
      if (seenAliases.has(alias)) continue;
      seenAliases.add(alias);
      entries.push({
        model_name: alias,
        litellm_params: { ...params },
      });
      mappedModels.push({
        modelName: alias,
        litellmModel,
        provider,
      });
    }
  }

  return {
    config: {
      model_list: entries,
      litellm_settings: {
        drop_params: true,
      },
      general_settings: {
        master_key: "os.environ/LITELLM_MASTER_KEY",
      },
    },
    mappedModels,
  };
}

export function writeLiteLLMConfig(
  paths: RuntimePaths,
  models: LiteLLMStoredModel[],
  providerOptions: LiteLLMProviderOption[],
): LiteLLMConfigResult {
  const configPath = litellmConfigPath(paths);
  resolveLiteLLMMasterKey({ workspaceDir: paths.sourceDir ?? paths.dataDir });
  const { config, mappedModels } = buildLiteLLMConfig(models, providerOptions);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    yaml.dump(config, { lineWidth: 120, noRefs: true }),
    "utf-8",
  );

  return {
    configPath,
    baseUrl: litellmBaseUrlFromEnv(),
    models: mappedModels,
  };
}
