type JsonRecord = Record<string, unknown>;

const CHANNEL_SECRET_FIELDS: Record<string, string[]> = {
  weixin: ["token", "encoding_aes_key"],
  telegram: ["token"],
  discord: ["token"],
  slack: ["bot_token", "app_token", "signing_secret"],
  feishu: ["app_secret", "encrypt_key", "verification_token"],
  dingtalk: ["webhook_url", "client_secret"],
  line: ["token", "channel_secret"],
  qq: ["token"],
  onebot: ["access_token"],
  whatsapp: ["webhook_token"],
  wecom: ["secret", "corp_secret", "webhook_url"],
  pico: ["token"],
  matrix: ["access_token"],
  irc: ["password", "nickserv_password", "sasl_password"],
  mqtt: ["username", "password"],
};

const CHANNEL_REQUIRED_FIELDS: Record<string, string[]> = {
  telegram: ["token"],
  discord: ["token"],
  slack: ["bot_token", "app_token"],
  feishu: ["app_id", "app_secret"],
  dingtalk: ["webhook_url"],
  line: ["token", "channel_secret"],
  qq: ["bot_id", "token"],
  onebot: ["server_url"],
  weixin: ["account_id"],
  wecom: ["bot_id"],
  whatsapp: ["bridge_url"],
  whatsapp_native: ["config"],
  pico: ["token"],
  maixcam: ["host"],
  matrix: ["homeserver_url", "user_id", "access_token"],
  irc: ["server", "nick"],
  mqtt: ["broker", "agent_id"],
};

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
  hasPicoToken?: boolean;
  mode?: ChannelProbeMode;
  extraChecks?: ChannelRuntimeProbeCheck[];
}

const CHANNEL_ENV_DISABLE_FLAGS: Record<string, string> = {
  telegram: "ENABLE_TELEGRAM",
  discord: "ENABLE_DISCORD",
  slack: "ENABLE_SLACK",
  feishu: "ENABLE_FEISHU",
  dingtalk: "ENABLE_DINGTALK",
  line: "ENABLE_LINE",
  qq: "ENABLE_QQ",
  onebot: "ENABLE_ONEBOT",
  weixin: "ENABLE_WEIXIN",
  wecom: "ENABLE_WECOM",
  whatsapp: "ENABLE_WHATSAPP",
  matrix: "ENABLE_MATRIX",
  irc: "ENABLE_IRC",
  mqtt: "ENABLE_MQTT",
};

const CHANNEL_ENV_FIELDS: Record<string, Record<string, string>> = {
  telegram: { token: "TELEGRAM_BOT_TOKEN" },
  discord: { token: "DISCORD_BOT_TOKEN" },
  slack: {
    bot_token: "SLACK_BOT_TOKEN",
    app_token: "SLACK_APP_TOKEN",
  },
  feishu: {
    app_id: "FEISHU_APP_ID",
    app_secret: "FEISHU_APP_SECRET",
    encrypt_key: "FEISHU_ENCRYPT_KEY",
    verification_token: "FEISHU_VERIFICATION_TOKEN",
  },
  dingtalk: {
    webhook_url: "DINGTALK_WEBHOOK_URL",
    client_secret: "DINGTALK_CLIENT_SECRET",
  },
  line: {
    token: "LINE_CHANNEL_ACCESS_TOKEN",
    channel_secret: "LINE_CHANNEL_SECRET",
  },
  qq: {
    bot_id: "QQ_BOT_ID",
    token: "QQ_BOT_TOKEN",
  },
  onebot: {
    server_url: "ONEBOT_SERVER_URL",
    access_token: "ONEBOT_ACCESS_TOKEN",
    bot_id: "ONEBOT_BOT_ID",
  },
  weixin: {
    account_id: "WEIXIN_ACCOUNT_ID",
    token: "WEIXIN_TOKEN",
    encoding_aes_key: "WEIXIN_ENCODING_AES_KEY",
  },
  wecom: {
    bot_id: "WECOM_BOT_ID",
    secret: "WECOM_SECRET",
    corp_secret: "WECOM_CORP_SECRET",
    webhook_url: "WECOM_WEBHOOK_URL",
  },
  whatsapp: {
    bridge_url: "WHATSAPP_BRIDGE_URL",
    webhook_token: "WHATSAPP_WEBHOOK_TOKEN",
  },
  matrix: {
    homeserver_url: "MATRIX_HOMESERVER_URL",
    user_id: "MATRIX_USER_ID",
    access_token: "MATRIX_ACCESS_TOKEN",
  },
  irc: {
    server: "IRC_SERVER",
    nick: "IRC_NICK",
    password: "IRC_PASSWORD",
    nickserv_password: "IRC_NICKSERV_PASSWORD",
    sasl_password: "IRC_SASL_PASSWORD",
  },
  mqtt: {
    broker: "MQTT_BROKER",
    agent_id: "MQTT_AGENT_ID",
    username: "MQTT_USERNAME",
    password: "MQTT_PASSWORD",
  },
};

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function channelFieldValue(config: JsonRecord, field: string): unknown {
  const direct = config[field];
  if (direct !== undefined) return direct;
  const settingsBlock = recordOrEmpty(config.settings);
  return settingsBlock[field];
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

function isValidUrlLike(value: unknown, protocols: readonly string[]): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return protocols.includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isNonEmptyIdentifier(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value.trim());
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
  if (channelName === "pico") fields.add("token");
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

  const enabledIsRequired = channel.name !== "pico";
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

  if (channel.name === "dingtalk" && configured) {
    const webhookUrl = channelFieldValue(config, "webhook_url");
    const hasValidWebhookUrl = isValidUrlLike(webhookUrl, ["http:", "https:"]);
    checks.push({
      id: "webhook_url_shape",
      status:
        hasValidWebhookUrl || configuredSecretSet.has("webhook_url")
          ? "pass"
          : "fail",
      message:
        "DingTalk webhook URL must be an HTTP(S) robot webhook endpoint.",
    });
    if (hasValidWebhookUrl) {
      const parsed = new URL(String(webhookUrl).trim());
      checks.push({
        id: "webhook_url_endpoint",
        status:
          parsed.hostname === "oapi.dingtalk.com" &&
          parsed.pathname === "/robot/send" &&
          parsed.searchParams.has("access_token")
            ? "pass"
            : "fail",
        message:
          "DingTalk webhook URL must target oapi.dingtalk.com/robot/send with access_token.",
      });
    }
  }

  if (channel.name === "feishu" && configured) {
    checks.push({
      id: "app_id_shape",
      status: isNonEmptyIdentifier(channelFieldValue(config, "app_id"))
        ? "pass"
        : "fail",
      message: "Feishu app_id must be a non-empty application identifier.",
    });
  }

  if (channel.name === "qq" && configured) {
    checks.push({
      id: "bot_id_shape",
      status:
        typeof channelFieldValue(config, "bot_id") === "string" &&
        /^\d{5,20}$/.test(String(channelFieldValue(config, "bot_id")).trim())
          ? "pass"
          : "fail",
      message: "QQ bot_id must be a 5-20 digit bot account ID.",
    });
  }

  if (channel.name === "whatsapp" && configured) {
    checks.push({
      id: "bridge_url_shape",
      status: isValidUrlLike(channelFieldValue(config, "bridge_url"), [
        "http:",
        "https:",
      ])
        ? "pass"
        : "fail",
      message: "WhatsApp bridge URL must use http:// or https://.",
    });
  }

  if (channel.name === "matrix" && configured) {
    checks.push({
      id: "homeserver_url_shape",
      status: isValidUrlLike(channelFieldValue(config, "homeserver_url"), [
        "http:",
        "https:",
      ])
        ? "pass"
        : "fail",
      message: "Matrix homeserver URL must use http:// or https://.",
    });
    const userId = channelFieldValue(config, "user_id");
    checks.push({
      id: "user_id_shape",
      status:
        typeof userId === "string" && /^@[^:\s]+:[^:\s]+$/.test(userId.trim())
          ? "pass"
          : "fail",
      message: "Matrix user ID must look like @user:homeserver.",
    });
  }

  if (channel.name === "onebot" && configured) {
    checks.push({
      id: "server_url_shape",
      status: isValidUrlLike(channelFieldValue(config, "server_url"), [
        "http:",
        "https:",
        "ws:",
        "wss:",
      ])
        ? "pass"
        : "fail",
      message: "OneBot server URL must use http(s):// or ws(s)://.",
    });
  }

  if (channel.name === "mqtt" && configured) {
    checks.push({
      id: "broker_url_shape",
      status: isValidUrlLike(channelFieldValue(config, "broker"), [
        "mqtt:",
        "mqtts:",
        "ssl:",
        "tcp:",
      ])
        ? "pass"
        : "fail",
      message: "MQTT broker must use mqtt://, mqtts://, ssl://, or tcp://.",
    });
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
    enabled: enabled || channel.name === "pico",
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
  if (env.Hiro_CHANNEL_LIVE_PROBES === "true") return "live";
  if (env.Hiro_CHANNEL_SANDBOX_PROBES === "true") return "sandbox";
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
  if (mode === "live" && env.Hiro_CHANNEL_ALLOW_LIVE_SEND !== "true") {
    return {
      status: "skipped",
      mode,
      message:
        "Live send check skipped; set Hiro_CHANNEL_ALLOW_LIVE_SEND=true to permit provider traffic.",
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
