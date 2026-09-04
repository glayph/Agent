type JsonRecord = Record<string, unknown>;

import { builtinChannelRegistry } from "../plugins/channels/builtin-channel-registry.js";
import { channelFieldValue } from "../plugins/channels/_shared/probe.js";

const BUILTIN_CHANNEL_MANIFESTS = builtinChannelRegistry.manifests();
const CHANNEL_SECRET_FIELDS: Record<string, string[]> = Object.fromEntries(
  BUILTIN_CHANNEL_MANIFESTS.map((channel) => [
    channel.name,
    [...channel.secret_fields],
  ]),
);
const CHANNEL_REQUIRED_FIELDS: Record<string, string[]> = Object.fromEntries([
  ...BUILTIN_CHANNEL_MANIFESTS.map((channel) => [
    channel.name,
    [...channel.required_fields] as string[],
  ]),
  ["whatsapp_native", ["config"]],
  ["maixcam", ["host"]],
]);

export type ChannelRuntimeStatus = "functional" | "partial" | "config_only";
export type ChannelProbeStatus =
  | "ready"
  | "disabled"
  | "needs_config"
  | "auth_failed"
  | "webhook_failed"
  | "rate_limited"
  | "runtime_error"
  | "partial"
  | "not_implemented";
export type ChannelProbeCheckStatus = "pass" | "warn" | "fail";
export type ChannelProbeMode = "mock" | "sandbox" | "live";

export interface SupportedChannelMetadata {
  name: string;
  display_name?: string;
  config_key: string;
  variant?: string;
  runtime_status?: ChannelRuntimeStatus;
  runtime_note?: string;
}

export interface ChannelRuntimeProbeCheck {
  id: string;
  status: ChannelProbeCheckStatus;
  message: string;
}

export interface ChannelRuntimeProbe {
  channel: string;
  display_name?: string;
  runtime_status: ChannelRuntimeStatus;
  probe_status: ChannelProbeStatus;
  agent_connected: boolean;
  enabled: boolean;
  configured: boolean;
  missing_fields: string[];
  checks: ChannelRuntimeProbeCheck[];
  check_mode: ChannelProbeMode;
  latency_ms: number;
  send_check?: {
    status: "passed" | "skipped" | "failed";
    mode: ChannelProbeMode;
    message: string;
    latency_ms: number;
  };
  failure_code?: string;
  next_steps: string[];
  setup_checklist: string[];
  checked_at: string;
}

type ChannelRuntimeSendCheck = NonNullable<ChannelRuntimeProbe["send_check"]>;

interface BuildChannelRuntimeProbeOptions {
  channel: SupportedChannelMetadata;
  config: JsonRecord;
  configuredSecrets?: string[];
  env?: NodeJS.ProcessEnv;
  hasmikiToken?: boolean;
  mode?: ChannelProbeMode;
  extraChecks?: ChannelRuntimeProbeCheck[];
}

const CHANNEL_ENV_DISABLE_FLAGS: Record<string, string> = Object.fromEntries(
  BUILTIN_CHANNEL_MANIFESTS.filter((channel) => channel.name !== "miki").map(
    (channel) => [channel.name, `ENABLE_${channel.name.toUpperCase()}`],
  ),
);

const CHANNEL_ENV_FIELDS: Record<
  string,
  Record<string, string>
> = Object.fromEntries(
  BUILTIN_CHANNEL_MANIFESTS.map((channel) => [
    channel.name,
    { ...(channel.env_fields || {}) },
  ]),
);

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function isChannelFieldConfigured(
  config: JsonRecord,
  configuredSecrets: Set<string>,
  field: string,
): boolean {
  if (configuredSecrets.has(field)) return true;
  const value = channelFieldValue(config, field);
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function configuredFieldSetForEnv(
  channelName: string,
  config: JsonRecord,
  configuredSecrets: Set<string>,
  env: NodeJS.ProcessEnv,
): Set<string> {
  const fields = new Set(configuredSecrets);
  const envMap = CHANNEL_ENV_FIELDS[channelName] || {};
  for (const [field, envKey] of Object.entries(envMap)) {
    if (env[envKey]) fields.add(field);
  }
  if (channelName === "miki") fields.add("token");
  for (const field of Object.keys(config)) {
    if (fieldConfigured(config, field)) fields.add(field);
  }
  return fields;
}

function fieldConfigured(config: JsonRecord, field: string): boolean {
  const value = channelFieldValue(config, field);
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

export function configuredSecretsForChannel(
  channelName: string,
  raw: JsonRecord,
): string[] {
  const settingsBlock = recordOrEmpty(raw.settings);
  return (CHANNEL_SECRET_FIELDS[channelName] || []).filter((key) => {
    const value = settingsBlock[key] ?? raw[key];
    return typeof value === "string" ? value.trim() !== "" : Boolean(value);
  });
}

export function flattenChannelConfig(
  raw: JsonRecord,
  channel: SupportedChannelMetadata,
) {
  const settingsBlock = recordOrEmpty(raw.settings);
  return { ...raw, ...settingsBlock, type: channel.config_key };
}

export function buildChannelRuntimeProbe({
  channel,
  config,
  configuredSecrets = [],
  env = process.env,
  mode,
  extraChecks = [],
}: BuildChannelRuntimeProbeOptions): ChannelRuntimeProbe {
  const runtimeStatus = channel.runtime_status || "config_only";
  const startedAt = Date.now();
  const checkMode = mode || resolveProbeMode(env);
  const enabled = config.enabled === true;
  const explicitlyDisabled = config.enabled === false;
  const configuredSecretSet = configuredFieldSetForEnv(
    channel.name,
    config,
    new Set(configuredSecrets),
    env,
  );

  const requiredFields = CHANNEL_REQUIRED_FIELDS[channel.name] || [];
  const missingFields = requiredFields.filter(
    (field) => !isChannelFieldConfigured(config, configuredSecretSet, field),
  );
  const configured =
    requiredFields.length === 0
      ? Object.keys(config).some((key) => key !== "type")
      : missingFields.length === 0;
  const checks: ChannelRuntimeProbeCheck[] = [];
  const nextSteps: string[] = [];
  const setupChecklist = requiredFields.map((field) => `Configure ${field}.`);
  if (runtimeStatus === "partial") {
    setupChecklist.push("Run live provider validation before production use.");
  }
  setupChecklist.push("Run the channel smoke test after saving credentials.");

  checks.push({
    id: "runtime_adapter",
    status:
      runtimeStatus === "functional"
        ? "pass"
        : runtimeStatus === "partial"
          ? "warn"
          : "fail",
    message:
      runtimeStatus === "functional"
        ? "A Node runtime adapter is present for this channel."
        : runtimeStatus === "partial"
          ? "Only part of this channel is wired into the default Node runtime."
          : "This channel currently has configuration UI but no proven Node runtime adapter.",
  });

  checks.push({
    id: "required_config",
    status: missingFields.length === 0 ? "pass" : "fail",
    message:
      missingFields.length === 0
        ? "Required saved configuration is present."
        : `Missing required saved fields: ${missingFields.join(", ")}.`,
  });

  const enabledIsRequired = channel.name !== "miki";
  const disableEnvKey = CHANNEL_ENV_DISABLE_FLAGS[channel.name];
  const disabledByEnv = Boolean(
    disableEnvKey && env[disableEnvKey] === "false",
  );
  checks.push({
    id: "enabled",
    status: !enabledIsRequired || enabled ? "pass" : "warn",
    message:
      !enabledIsRequired || enabled
        ? "Channel is available for runtime use."
        : "Channel is saved but disabled in the channel configuration.",
  });

  if (disableEnvKey) {
    checks.push({
      id: "runtime_enable_flag",
      status: disabledByEnv ? "fail" : "pass",
      message: disabledByEnv
        ? `${disableEnvKey}=false disables this channel at runtime.`
        : `${disableEnvKey} does not disable this channel.`,
    });
  }

  const channelProbe = builtinChannelRegistry.get(channel.name)?.manifest
    .probe_config;
  if (configured && channelProbe) {
    checks.push(...channelProbe(config, configuredSecretSet));
  }

  checks.push(...extraChecks);

  const sendCheck = buildMockSendCheck({
    channelName: channel.name,
    configured,
    runtimeStatus,
    checks,
    mode: checkMode,
    env,
  });
  if (sendCheck.status === "passed") {
    checks.push({
      id: "outbound_send",
      status: "pass",
      message: sendCheck.message,
    });
  } else if (sendCheck.status === "failed") {
    checks.push({
      id: "outbound_send",
      status: "fail",
      message: sendCheck.message,
    });
  }

  let probeStatus: ChannelProbeStatus;
  if (runtimeStatus === "config_only") {
    probeStatus = "not_implemented";
    nextSteps.push(
      "Implement a Node runtime adapter before enabling this channel in production.",
    );
  } else if (enabledIsRequired && explicitlyDisabled) {
    probeStatus = "disabled";
    nextSteps.push(
      missingFields.length > 0
        ? `Channel is disabled. Fill and save before enabling: ${missingFields.join(", ")}.`
        : "Enable the channel and save the configuration.",
    );
  } else if (disabledByEnv) {
    probeStatus = "disabled";
    nextSteps.push(`Remove ${disableEnvKey}=false and restart the gateway.`);
  } else if (missingFields.length > 0) {
    probeStatus = "needs_config";
    nextSteps.push(`Fill and save: ${missingFields.join(", ")}.`);
  } else if (checks.some((check) => check.status === "fail")) {
    probeStatus = classifyFailedProbe(checks);
    nextSteps.push("Fix the failing probe checks and run the probe again.");
  } else {
    probeStatus = "ready";
  }
  const failureCode = checks.find((check) => check.status === "fail")?.id;

  return {
    channel: channel.name,
    display_name: channel.display_name,
    runtime_status: runtimeStatus,
    probe_status: probeStatus,
    agent_connected: probeStatus === "ready",
    enabled: enabled || channel.name === "miki",
    configured,
    missing_fields: missingFields,
    checks,
    check_mode: checkMode,
    latency_ms: Date.now() - startedAt,
    send_check: sendCheck,
    failure_code: failureCode,
    next_steps: nextSteps,
    setup_checklist: setupChecklist,
    checked_at: new Date().toISOString(),
  };
}

function classifyFailedProbe(
  checks: ChannelRuntimeProbeCheck[],
): ChannelProbeStatus {
  const failed = checks.find((check) => check.status === "fail");
  if (!failed) return "ready";
  if (/auth|token|credential/i.test(failed.id)) return "auth_failed";
  if (/webhook/i.test(failed.id)) return "webhook_failed";
  if (/rate.?limit/i.test(failed.id)) return "rate_limited";
  return "needs_config";
}

function resolveProbeMode(env: NodeJS.ProcessEnv): ChannelProbeMode {
  if (
    env.MIKI_CHANNEL_LIVE_PROBES === "true" ||
    env.Miki_CHANNEL_LIVE_PROBES === "true"
  )
    return "live";
  if (
    env.MIKI_CHANNEL_SANDBOX_PROBES === "true" ||
    env.Miki_CHANNEL_SANDBOX_PROBES === "true"
  )
    return "sandbox";
  return "mock";
}

function buildMockSendCheck({
  channelName,
  configured,
  runtimeStatus,
  checks,
  mode,
  env,
}: {
  channelName: string;
  configured: boolean;
  runtimeStatus: ChannelRuntimeStatus;
  checks: ChannelRuntimeProbeCheck[];
  mode: ChannelProbeMode;
  env: NodeJS.ProcessEnv;
}): ChannelRuntimeSendCheck {
  const startedAt = Date.now();
  if (!configured || runtimeStatus === "config_only") {
    return {
      status: "skipped",
      mode,
      message:
        "Outbound send check skipped until required configuration exists.",
      latency_ms: Date.now() - startedAt,
    };
  }
  if (checks.some((check) => check.status === "fail")) {
    return {
      status: "skipped",
      mode,
      message:
        "Outbound send check skipped because configuration checks failed.",
      latency_ms: Date.now() - startedAt,
    };
  }
  const liveSendAllowed =
    env.MIKI_CHANNEL_ALLOW_LIVE_SEND === "true" ||
    env.Miki_CHANNEL_ALLOW_LIVE_SEND === "true";
  if (mode === "live" && !liveSendAllowed) {
    return {
      status: "skipped",
      mode,
      message:
        "Live send check skipped; set Miki_CHANNEL_ALLOW_LIVE_SEND=true to permit provider traffic.",
      latency_ms: Date.now() - startedAt,
    };
  }
  return {
    status: "passed",
    mode,
    message:
      mode === "live"
        ? `Live send preflight is enabled for ${channelName}; provider call remains adapter-controlled.`
        : `${mode} outbound send contract passed without external provider traffic.`,
    latency_ms: Date.now() - startedAt,
  };
}
