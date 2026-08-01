import {
  requiredFieldChecks,
  redactChannelAdapterConfig,
  runChannelAdapterProbe,
  type ChannelAdapter,
  type ChannelAdapterContext,
} from "../channels/adapter-sdk.js";
import type {
  ChannelProbeMode,
  ChannelRuntimeProbe,
  ChannelRuntimeProbeCheck,
  ChannelRuntimeStatus,
  SupportedChannelMetadata,
} from "../api/channel-runtime-probe.js";
import {
  executeRuntimePluginContract,
  loadRuntimePluginContracts,
  type RuntimePluginContract,
} from "./plugin-contract-runtime.js";

interface RuntimePluginChannelOptions {
  skillsDir?: string;
  configPath?: string;
  configuredSecrets?: string[];
  env?: NodeJS.ProcessEnv;
  mode?: ChannelProbeMode;
  now?: Date;
}

export interface RuntimePluginChannelDescriptor {
  pluginName: string;
  contractName: string;
  metadata: SupportedChannelMetadata;
  requiredFields: string[];
  secretFields: string[];
  contract: RuntimePluginContract;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function metadataString(
  metadata: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function metadataStringArray(
  metadata: Record<string, unknown>,
  ...keys: string[]
): string[] {
  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function metadataRuntimeStatus(
  metadata: Record<string, unknown>,
): ChannelRuntimeStatus | undefined {
  const value = metadataString(metadata, "runtime_status", "runtimeStatus");
  if (
    value === "functional" ||
    value === "partial" ||
    value === "config_only"
  ) {
    return value;
  }
  return undefined;
}

function safeChannelName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "plugin_channel";
}

function runtimeStatusForContract(
  contract: RuntimePluginContract,
  metadata: Record<string, unknown>,
): ChannelRuntimeStatus {
  const declared = metadataRuntimeStatus(metadata);
  if (contract.readiness.executable && contract.readiness.status === "ready") {
    return declared || "functional";
  }
  if (contract.readiness.status === "requires_policy") return "partial";
  if (contract.readiness.status === "ready") return declared || "partial";
  return "config_only";
}

function descriptorForContract(
  contract: RuntimePluginContract,
): RuntimePluginChannelDescriptor {
  const metadata = isRecord(contract.contract.metadata)
    ? contract.contract.metadata
    : {};
  const name = safeChannelName(
    metadataString(metadata, "name") || contract.contract.name,
  );
  const configKey = safeChannelName(
    metadataString(metadata, "config_key", "configKey") || name,
  );

  return {
    pluginName: contract.plugin.name,
    contractName: contract.contract.name,
    metadata: {
      name,
      display_name:
        metadataString(metadata, "display_name", "displayName") ||
        contract.contract.description ||
        contract.contract.name,
      config_key: configKey,
      variant: metadataString(metadata, "variant"),
      runtime_status: runtimeStatusForContract(contract, metadata),
      runtime_note:
        metadataString(metadata, "runtime_note", "runtimeNote") ||
        (contract.readiness.reasons.length > 0
          ? contract.readiness.reasons.join(" ")
          : `Plugin channel contract from ${contract.plugin.name}.`),
    },
    requiredFields: metadataStringArray(
      metadata,
      "required_fields",
      "requiredFields",
    ),
    secretFields: metadataStringArray(
      metadata,
      "secret_fields",
      "secretFields",
    ),
    contract,
  };
}

function readinessCheck(
  descriptor: RuntimePluginChannelDescriptor,
): ChannelRuntimeProbeCheck {
  const { contract } = descriptor;
  const status = contract.readiness.status;
  const passing = status === "ready" || status === "metadata_only";
  return {
    id: "plugin_contract_readiness",
    status: passing ? "pass" : status === "requires_policy" ? "warn" : "fail",
    message:
      contract.readiness.reasons.join(" ") ||
      `Plugin channel contract ${descriptor.pluginName}:${descriptor.contractName} is ${status}.`,
  };
}

function permissionCheck(
  descriptor: RuntimePluginChannelDescriptor,
): ChannelRuntimeProbeCheck {
  const permissions = descriptor.contract.permissions;
  return {
    id: "plugin_contract_permissions",
    status:
      descriptor.contract.readiness.risk.requiresPolicy.length > 0
        ? "warn"
        : "pass",
    message:
      permissions.length > 0
        ? `Plugin channel declares permissions: ${permissions.join(", ")}.`
        : "Plugin channel does not declare elevated permissions.",
  };
}

function envForProbeMode(
  env: NodeJS.ProcessEnv | undefined,
  mode: ChannelProbeMode | undefined,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...(env || process.env) };
  if (mode === "live") {
    nextEnv.Hiro_CHANNEL_LIVE_PROBES = "true";
    delete nextEnv.Hiro_CHANNEL_SANDBOX_PROBES;
  } else if (mode === "sandbox") {
    nextEnv.Hiro_CHANNEL_SANDBOX_PROBES = "true";
    delete nextEnv.Hiro_CHANNEL_LIVE_PROBES;
  } else if (mode === "mock") {
    delete nextEnv.Hiro_CHANNEL_LIVE_PROBES;
    delete nextEnv.Hiro_CHANNEL_SANDBOX_PROBES;
  }
  return nextEnv;
}

function executableProbeEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.Hiro_CHANNEL_LIVE_PROBES === "true" ||
    env.Hiro_CHANNEL_SANDBOX_PROBES === "true"
  );
}

function normalizePluginProbeChecks(
  output: string,
): ChannelRuntimeProbeCheck[] | undefined {
  if (!output.trim()) return undefined;
  try {
    const parsed = JSON.parse(output) as unknown;
    const checks = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.checks)
        ? parsed.checks
        : undefined;
    if (!checks) return undefined;
    const normalized: ChannelRuntimeProbeCheck[] = [];
    for (const check of checks.filter(isRecord)) {
      const id = metadataString(check, "id");
      const status = metadataString(check, "status");
      const message = metadataString(check, "message");
      if (
        !id ||
        !message ||
        (status !== "pass" && status !== "warn" && status !== "fail")
      ) {
        continue;
      }
      normalized.push({ id, status, message });
    }
    return normalized.length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

async function runExecutableChannelProbe(
  workspaceDir: string,
  descriptor: RuntimePluginChannelDescriptor,
  context: ChannelAdapterContext,
  options: RuntimePluginChannelOptions,
): Promise<ChannelRuntimeProbeCheck[]> {
  const env = context.env || process.env;
  if (!executableProbeEnabled(env)) {
    return [
      {
        id: "plugin_probe",
        status: "warn",
        message:
          "Plugin channel probe entrypoint is available; execution is skipped in mock probe mode.",
      },
    ];
  }

  const result = await executeRuntimePluginContract(
    workspaceDir,
    "channels",
    `${descriptor.pluginName}:${descriptor.contractName}`,
    {
      action: "probe",
      config: redactChannelAdapterConfig(
        context.config,
        descriptor.secretFields,
        context.configuredSecrets || [],
      ),
      configuredSecrets: context.configuredSecrets || [],
    },
    {
      skillsDir: options.skillsDir,
      configPath: options.configPath,
    },
  );

  if (!result.success) {
    return [
      {
        id: "plugin_probe",
        status: "fail",
        message: result.error || "Plugin channel probe failed.",
      },
    ];
  }

  return (
    normalizePluginProbeChecks(result.output) || [
      {
        id: "plugin_probe",
        status: "pass",
        message: result.output || "Plugin channel probe completed.",
      },
    ]
  );
}

export async function listRuntimePluginChannelDescriptors(
  workspaceDir: string,
  options: RuntimePluginChannelOptions = {},
): Promise<RuntimePluginChannelDescriptor[]> {
  const contracts = await loadRuntimePluginContracts(workspaceDir, {
    skillsDir: options.skillsDir,
    configPath: options.configPath,
    kind: "channels",
  });
  return contracts.map(descriptorForContract);
}

export async function listRuntimePluginChannelMetadata(
  workspaceDir: string,
  options: RuntimePluginChannelOptions = {},
): Promise<SupportedChannelMetadata[]> {
  const descriptors = await listRuntimePluginChannelDescriptors(
    workspaceDir,
    options,
  );
  return descriptors.map((descriptor) => descriptor.metadata);
}

export async function findRuntimePluginChannelDescriptor(
  workspaceDir: string,
  channelName: string,
  options: RuntimePluginChannelOptions = {},
): Promise<RuntimePluginChannelDescriptor | undefined> {
  const descriptors = await listRuntimePluginChannelDescriptors(
    workspaceDir,
    options,
  );
  return descriptors.find(
    (descriptor) =>
      descriptor.metadata.name === channelName ||
      descriptor.metadata.config_key === channelName ||
      descriptor.contractName === channelName ||
      `${descriptor.pluginName}:${descriptor.contractName}` === channelName,
  );
}

export function createRuntimePluginChannelAdapter(
  workspaceDir: string,
  descriptor: RuntimePluginChannelDescriptor,
  options: RuntimePluginChannelOptions = {},
): ChannelAdapter {
  const adapter: ChannelAdapter = {
    metadata: descriptor.metadata,
    requiredFields: descriptor.requiredFields,
    secretFields: descriptor.secretFields,
    validateConfig(context) {
      return [
        ...requiredFieldChecks(
          { requiredFields: descriptor.requiredFields },
          context.config,
          context.configuredSecrets,
        ),
        readinessCheck(descriptor),
        permissionCheck(descriptor),
      ];
    },
  };

  if (descriptor.contract.readiness.entrypointPath) {
    adapter.liveValidate = (context) =>
      runExecutableChannelProbe(workspaceDir, descriptor, context, options);
  }

  return adapter;
}

export async function probeRuntimePluginChannel(
  workspaceDir: string,
  channelName: string,
  config: Record<string, unknown>,
  options: RuntimePluginChannelOptions = {},
): Promise<ChannelRuntimeProbe | undefined> {
  const descriptor = await findRuntimePluginChannelDescriptor(
    workspaceDir,
    channelName,
    options,
  );
  if (!descriptor) return undefined;

  return runChannelAdapterProbe(
    createRuntimePluginChannelAdapter(workspaceDir, descriptor, options),
    {
      config,
      configuredSecrets: options.configuredSecrets,
      env: envForProbeMode(options.env, options.mode),
      now: options.now,
    },
  );
}
