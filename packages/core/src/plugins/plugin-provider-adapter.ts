import {
  executeRuntimePluginContract,
  loadRuntimePluginContracts,
  type RuntimePluginContract,
} from "./plugin-contract-runtime.js";

type JsonRecord = Record<string, unknown>;

export interface RuntimePluginProviderMetadata {
  id: string;
  name: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnvVar: string;
  models: string[];
  isActive: boolean;
  local: boolean;
  supportsFetch: boolean;
  authMethod: string;
  source: "plugin";
  pluginName: string;
  contractName: string;
  runtimeStatus: RuntimePluginContract["readiness"]["status"];
  runtimeNote?: string;
}

export interface RuntimePluginProviderDescriptor {
  pluginName: string;
  contractName: string;
  provider: RuntimePluginProviderMetadata;
  secretFields: string[];
  contract: RuntimePluginContract;
}

export interface RuntimePluginProviderProbe {
  provider: RuntimePluginProviderMetadata;
  success: boolean;
  status: "ready" | "metadata_only" | "policy_blocked" | "unreachable";
  latencyMs: number;
  models: string[];
  error?: string;
}

interface RuntimePluginProviderOptions {
  skillsDir?: string;
  configPath?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boolValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(stringValue).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function metadataString(metadata: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(metadata[key]);
    if (value) return value;
  }
  return "";
}

function safeProviderId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "plugin-provider";
}

function providerDescriptorForContract(
  contract: RuntimePluginContract,
): RuntimePluginProviderDescriptor {
  const metadata = isRecord(contract.contract.metadata)
    ? contract.contract.metadata
    : {};
  const id = safeProviderId(
    metadataString(metadata, "id", "provider_id", "providerId") ||
      contract.contract.name,
  );
  const displayName =
    metadataString(metadata, "display_name", "displayName", "name") ||
    contract.contract.description ||
    id;

  return {
    pluginName: contract.plugin.name,
    contractName: contract.contract.name,
    provider: {
      id,
      name: displayName,
      displayName,
      baseUrl: metadataString(
        metadata,
        "base_url",
        "baseUrl",
        "default_api_base",
        "defaultApiBase",
      ),
      apiKeyEnvVar: metadataString(
        metadata,
        "api_key_env",
        "apiKeyEnv",
        "apiKeyEnvVar",
      ),
      models: stringArray(metadata.models || metadata.common_models),
      isActive:
        contract.readiness.status === "ready" ||
        contract.readiness.status === "metadata_only",
      local: boolValue(metadata.local),
      supportsFetch: boolValue(
        metadata.supports_fetch ?? metadata.supportsFetch,
        Boolean(contract.contract.entrypoint),
      ),
      authMethod:
        metadataString(metadata, "auth_method", "authMethod") || "api_key",
      source: "plugin",
      pluginName: contract.plugin.name,
      contractName: contract.contract.name,
      runtimeStatus: contract.readiness.status,
      runtimeNote:
        contract.readiness.reasons.join(" ") ||
        metadataString(metadata, "runtime_note", "runtimeNote") ||
        undefined,
    },
    secretFields: stringArray(
      metadata.secret_fields || metadata.secretFields || ["api_key"],
    ),
    contract,
  };
}

function normalizeModelsFromOutput(output: string): string[] {
  if (!output.trim()) return [];
  try {
    const parsed = JSON.parse(output) as unknown;
    const models = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.models)
        ? parsed.models
        : undefined;
    if (!models) return [];
    return models
      .map((item) =>
        typeof item === "string"
          ? item.trim()
          : isRecord(item)
            ? stringValue(item.id || item.name || item.model)
            : "",
      )
      .filter(Boolean);
  } catch {
    return output
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function normalizeProbeStatus(
  status: RuntimePluginContract["readiness"]["status"] | undefined,
): RuntimePluginProviderProbe["status"] {
  if (
    status === "ready" ||
    status === "metadata_only" ||
    status === "policy_blocked"
  ) {
    return status;
  }
  if (
    status === "needs_entrypoint" ||
    status === "unsupported_runtime" ||
    status === "requires_policy"
  ) {
    return "policy_blocked";
  }
  return "unreachable";
}

export async function listRuntimePluginProviderDescriptors(
  workspaceDir: string,
  options: RuntimePluginProviderOptions = {},
): Promise<RuntimePluginProviderDescriptor[]> {
  const contracts = await loadRuntimePluginContracts(workspaceDir, {
    skillsDir: options.skillsDir,
    configPath: options.configPath,
    kind: "providers",
  });
  return contracts.map(providerDescriptorForContract);
}

export async function listRuntimePluginProviderMetadata(
  workspaceDir: string,
  options: RuntimePluginProviderOptions = {},
): Promise<RuntimePluginProviderMetadata[]> {
  const descriptors = await listRuntimePluginProviderDescriptors(
    workspaceDir,
    options,
  );
  return descriptors.map((descriptor) => descriptor.provider);
}

export async function findRuntimePluginProviderDescriptor(
  workspaceDir: string,
  providerId: string,
  options: RuntimePluginProviderOptions = {},
): Promise<RuntimePluginProviderDescriptor | undefined> {
  const descriptors = await listRuntimePluginProviderDescriptors(
    workspaceDir,
    options,
  );
  return descriptors.find(
    (descriptor) =>
      descriptor.provider.id === providerId ||
      descriptor.contractName === providerId ||
      `${descriptor.pluginName}:${descriptor.contractName}` === providerId,
  );
}

export async function probeRuntimePluginProvider(
  workspaceDir: string,
  providerId: string,
  payload: JsonRecord = {},
  options: RuntimePluginProviderOptions = {},
): Promise<RuntimePluginProviderProbe | undefined> {
  const descriptor = await findRuntimePluginProviderDescriptor(
    workspaceDir,
    providerId,
    options,
  );
  if (!descriptor) return undefined;

  const startedAt = Date.now();
  const metadataOnly =
    !descriptor.contract.contract.entrypoint ||
    !descriptor.contract.readiness.executable;
  if (metadataOnly) {
    return {
      provider: descriptor.provider,
      success:
        descriptor.contract.readiness.status === "metadata_only" ||
        descriptor.contract.readiness.status === "ready",
      status:
        descriptor.contract.readiness.status === "metadata_only"
          ? "metadata_only"
          : "policy_blocked",
      latencyMs: Date.now() - startedAt,
      models: descriptor.provider.models,
      error: descriptor.contract.readiness.reasons.join(" ") || undefined,
    };
  }

  const result = await executeRuntimePluginContract(
    workspaceDir,
    "providers",
    `${descriptor.pluginName}:${descriptor.contractName}`,
    {
      action: payload.action || "probe",
      provider: descriptor.provider,
      args: payload,
    },
    options,
  );

  return {
    provider: descriptor.provider,
    success: result.success,
    status: result.success ? "ready" : normalizeProbeStatus(result.status),
    latencyMs: Date.now() - startedAt,
    models: result.success
      ? normalizeModelsFromOutput(result.output)
      : descriptor.provider.models,
    error: result.error,
  };
}

export async function fetchRuntimePluginProviderModels(
  workspaceDir: string,
  providerId: string,
  payload: JsonRecord = {},
  options: RuntimePluginProviderOptions = {},
): Promise<string[] | undefined> {
  const probe = await probeRuntimePluginProvider(
    workspaceDir,
    providerId,
    { ...payload, action: "models" },
    options,
  );
  return probe?.models;
}
