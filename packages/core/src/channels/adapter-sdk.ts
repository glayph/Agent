import {
  type ChannelProbeCheckStatus,
  type ChannelRuntimeProbe,
  type ChannelRuntimeProbeCheck,
  type SupportedChannelMetadata,
} from "../api/channel-runtime-probe.js";

export interface ChannelAdapterContext {
  config: Record<string, unknown>;
  configuredSecrets?: string[];
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface ChannelAdapter {
  metadata: SupportedChannelMetadata;
  requiredFields: string[];
  secretFields: string[];
  validateConfig(context: ChannelAdapterContext): ChannelRuntimeProbeCheck[];
  liveValidate?(
    context: ChannelAdapterContext,
  ): Promise<ChannelRuntimeProbeCheck[]>;
}

export const REDACTED_CHANNEL_SECRET = "[redacted]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function channelAdapterFieldValue(
  config: Record<string, unknown>,
  field: string,
): unknown {
  const direct = config[field];
  if (direct !== undefined) return direct;
  const settings = isRecord(config.settings) ? config.settings : {};
  return settings[field];
}

function fieldConfigured(
  config: Record<string, unknown>,
  field: string,
): boolean {
  const value = channelAdapterFieldValue(config, field);
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

export function redactChannelAdapterConfig(
  config: Record<string, unknown>,
  secretFields: string[] = [],
  configuredSecrets: string[] = [],
): Record<string, unknown> {
  const secretSet = new Set([...secretFields, ...configuredSecrets]);
  const redacted: Record<string, unknown> = { ...config };
  const settings = isRecord(config.settings)
    ? ({ ...config.settings } as Record<string, unknown>)
    : undefined;

  for (const field of secretSet) {
    if (Object.prototype.hasOwnProperty.call(redacted, field)) {
      redacted[field] = REDACTED_CHANNEL_SECRET;
    }
    if (settings && Object.prototype.hasOwnProperty.call(settings, field)) {
      settings[field] = REDACTED_CHANNEL_SECRET;
    }
  }

  if (settings) {
    redacted.settings = settings;
  }
  return redacted;
}

export function requiredFieldChecks(
  adapter: Pick<ChannelAdapter, "requiredFields">,
  config: Record<string, unknown>,
  configuredSecrets: string[] = [],
): ChannelRuntimeProbeCheck[] {
  const configuredSecretSet = new Set(configuredSecrets);
  return adapter.requiredFields.map((field) => ({
    id: `required:${field}`,
    status:
      fieldConfigured(config, field) || configuredSecretSet.has(field)
        ? "pass"
        : "fail",
    message:
      fieldConfigured(config, field) || configuredSecretSet.has(field)
        ? `${field} is configured.`
        : `${field} is required.`,
  }));
}

export function channelSetupChecklist(adapter: ChannelAdapter): string[] {
  const steps = adapter.requiredFields.map((field) => `Configure ${field}.`);
  if (adapter.metadata.runtime_status === "partial") {
    steps.push("Run live provider validation before production use.");
  }
  steps.push("Run the channel smoke test after saving credentials.");
  return steps;
}

export async function runChannelAdapterProbe(
  adapter: ChannelAdapter,
  context: ChannelAdapterContext,
): Promise<ChannelRuntimeProbe> {
  const startedAt = Date.now();
  const configChecks = adapter.validateConfig(context);
  const liveChecks = adapter.liveValidate
    ? await adapter.liveValidate(context)
    : [];
  const checks = [...configChecks, ...liveChecks];
  const missingFields = configChecks
    .filter(
      (check) => check.status === "fail" && check.id.startsWith("required:"),
    )
    .map((check) => check.id.slice("required:".length));
  const failed = checks.some((check) => check.status === "fail");
  const warned = checks.some((check) => check.status === "warn");
  const runtimeStatus = adapter.metadata.runtime_status || "config_only";
  const checkMode = resolveAdapterProbeMode(context.env || process.env);
  const failureCode = checks.find((check) => check.status === "fail")?.id;

  return {
    channel: adapter.metadata.name,
    display_name: adapter.metadata.display_name,
    runtime_status: runtimeStatus,
    probe_status: failed
      ? "needs_config"
      : warned || runtimeStatus === "partial"
        ? "partial"
        : runtimeStatus === "config_only"
          ? "not_implemented"
          : "ready",
    agent_connected: !failed && !warned && runtimeStatus === "functional",
    enabled: context.config.enabled === true,
    configured: missingFields.length === 0,
    missing_fields: missingFields,
    checks,
    check_mode: checkMode,
    latency_ms: Date.now() - startedAt,
    send_check: {
      status: failed || runtimeStatus === "config_only" ? "skipped" : "passed",
      mode: checkMode,
      message:
        failed || runtimeStatus === "config_only"
          ? "Outbound send check skipped until adapter configuration is ready."
          : `${checkMode} outbound send contract passed through the adapter harness.`,
      latency_ms: 0,
    },
    failure_code: failureCode,
    next_steps: failed ? channelSetupChecklist(adapter) : [],
    setup_checklist: channelSetupChecklist(adapter),
    checked_at: (context.now || new Date()).toISOString(),
  };
}

function resolveAdapterProbeMode(env: NodeJS.ProcessEnv) {
  if (env.Hiro_CHANNEL_LIVE_PROBES === "true") return "live" as const;
  if (env.Hiro_CHANNEL_SANDBOX_PROBES === "true") return "sandbox" as const;
  return "mock" as const;
}

export function createChannelAdapterHarness(adapter: ChannelAdapter) {
  return {
    async probe(config: Record<string, unknown>) {
      return runChannelAdapterProbe(adapter, { config });
    },
    expectCheck(
      checks: ChannelRuntimeProbeCheck[],
      id: string,
      status: ChannelProbeCheckStatus,
    ): void {
      const check = checks.find((item) => item.id === id);
      if (!check) throw new Error(`Missing channel check: ${id}`);
      if (check.status !== status) {
        throw new Error(`Expected ${id}=${status}, got ${check.status}`);
      }
    },
  };
}
