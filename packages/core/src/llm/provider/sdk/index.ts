import type { LLMResponse } from "@miki/config";

export const MIKI_PROVIDER_PLUGIN_API_VERSION = "1.0";

export type ProviderInputKind = "text" | "image" | "audio";
export type ProviderAuthMode =
  "api-key" | "oauth" | "none" | "local" | "placeholder";
export type ProviderApiKind =
  "openai-completions" | "openai-responses" | "gemini" | "anthropic" | "local";

export interface MikiProviderCapabilities {
  chat: boolean;
  tools: boolean;
  streaming: boolean;
  vision: boolean;
  local: boolean;
}

export interface MikiProviderManifest {
  id: string;
  displayName: string;
  version: string;
  pluginApiVersion: string;
  minMikiVersion?: string;
  entrypoint?: string;
  capabilities: MikiProviderCapabilities;
  modelPrefixes?: string[];
  modelIds?: string[];
  permissions?: Array<"network" | "filesystem" | "shell" | "secrets">;
}

export interface MikiProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ProviderInputKind[];
  contextWindow: number;
  maxTokens: number;
  supportsTools?: boolean;
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface MikiProviderAuth {
  mode: ProviderAuthMode;
  envVars?: string[];
  allowEmptyKey: boolean;
  secretFields?: string[];
}

export interface MikiProviderContext {
  workspaceDir: string;
  configDir: string;
  mikiVersion: string;
  signal?: AbortSignal;
  log(event: string, details?: Record<string, unknown>): void;
}

export interface MikiProviderEndpoint {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv?: string;
  emptyApiKeyAllowed: boolean;
  authMode: ProviderAuthMode;
  local?: boolean;
}

export interface MikiProviderCatalogResult {
  baseUrl?: string;
  api?: ProviderApiKind;
  auth: MikiProviderAuth;
  models: MikiProviderModel[];
}

export interface MikiProviderAudio {
  data: string;
  mimeType: string;
  filename?: string;
}

export interface MikiProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
  image_urls?: string[];
  audio?: MikiProviderAudio;
}

export interface MikiProviderCompletionRequest {
  provider: MikiProviderEndpoint;
  model: string;
  messages: MikiProviderMessage[];
  credentials: Readonly<Record<string, string>>;
  extra?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  context: MikiProviderContext;
}

export interface ProviderConnectionResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

export interface MikiProviderPlugin {
  manifest: MikiProviderManifest;
  auth: MikiProviderAuth;
  catalog(
    context: MikiProviderContext,
  ): Promise<MikiProviderCatalogResult | null>;
  complete(request: MikiProviderCompletionRequest): Promise<LLMResponse>;
  listModels?(context: MikiProviderContext): Promise<MikiProviderModel[]>;
  testConnection?(
    context: MikiProviderContext,
  ): Promise<ProviderConnectionResult>;
  shutdown?(): Promise<void>;
}

export interface ProviderManifestValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ProviderPluginDescriptor {
  manifest: MikiProviderManifest;
  auth: MikiProviderAuth;
  source: "builtin" | "external";
  readiness: "ready" | "metadata_only" | "incompatible" | "rejected";
  reason?: string;
}
