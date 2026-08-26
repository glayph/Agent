import { z } from "zod";

export const CURRENT_CONFIG_SCHEMA_VERSION = 1;

const JsonRecordSchema = z.record(z.unknown());
const PrimitiveConfigValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const SUPPORTED_CHANNEL_NAMES = new Set([
  "telegram",
  "discord",
  "slack",
  "feishu",
  "dingtalk",
  "line",
  "qq",
  "matrix",
  "irc",
  "onebot",
  "mqtt",
  "whatsapp",
  "miki",
  "weixin",
  "wecom",
]);

const SUPPORTED_WEB_SEARCH_PROVIDERS = new Set([
  "native",
  "brave",
  "duckduckgo",
  "exa",
  "firecrawl",
  "gemini",
  "grok",
  "xai",
  "kimi",
  "minimax",
  "ollama",
  "perplexity",
  "searx",
  "searxng",
  "serpapi",
  "serper",
  "tavily",
  "bing",
  "glm_search",
  "baidu_search",
]);

const UNSAFE_MCP_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PYTHONPATH",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
]);

const MCPTransportSchema = z.enum(["stdio", "sse", "http", "streamable_http"]);

const SecretRefSchema = z
  .object({
    secret_ref: z.string().min(1),
  })
  .passthrough();

const HeaderValueSchema = z.union([z.string(), SecretRefSchema, z.null()]);

const MCPServerSchema = z
  .object({
    enabled: z.boolean().optional(),
    deferred: z.boolean().optional(),
    type: MCPTransportSchema.optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(PrimitiveConfigValueSchema).optional(),
    env_file: z.string().nullable().optional(),
    url: z.string().optional(),
    headers: z.record(HeaderValueSchema).optional(),
  })
  .passthrough();

const ToolsSchema = z
  .object({
    cron: z
      .object({
        allow_command: z.boolean().optional(),
        exec_timeout_minutes: z.number().int().min(0).max(1440).optional(),
      })
      .passthrough()
      .optional(),
    exec: z
      .object({
        enabled: z.boolean().optional(),
        allow_remote: z.boolean().optional(),
        enable_deny_patterns: z.boolean().optional(),
        custom_allow_patterns: z.array(z.string()).optional(),
        custom_deny_patterns: z.array(z.string()).optional(),
        timeout_seconds: z.number().int().min(0).max(86400).optional(),
      })
      .passthrough()
      .optional(),
    mcp: z
      .object({
        enabled: z.boolean().optional(),
        discovery: z
          .object({
            enabled: z.boolean().optional(),
            ttl: z.number().int().min(1).max(86400).optional(),
            max_search_results: z.number().int().min(1).max(100).optional(),
            use_bm25: z.boolean().optional(),
            use_regex: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        servers: z.record(MCPServerSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const WebSearchProviderSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    configured: z.boolean().optional(),
    current: z.boolean().optional(),
    requires_auth: z.boolean().optional(),
  })
  .passthrough();

const WebSearchProviderSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    max_results: z.number().int().min(1).max(50).optional(),
    base_url: z.string().optional(),
    api_key: z.string().optional(),
    api_key_set: z.boolean().optional(),
    model: z.string().optional(),
  })
  .passthrough();

const WebSearchOptimizationSchema = z
  .object({
    cache_enabled: z.boolean().optional(),
    cache_ttl_ms: z.number().int().min(0).max(86400000).optional(),
    snippet_chars: z.number().int().min(120).max(1000).optional(),
  })
  .passthrough();

const WebSearchSchema = z
  .object({
    execution_mode: z.enum(["local", "cloud", "api", "auto"]).optional(),
    provider: z.string().min(1).optional(),
    current_service: z.string().min(1).optional(),
    prefer_native: z.boolean().optional(),
    proxy: z.string().optional(),
    optimization: WebSearchOptimizationSchema.optional(),
    providers: z.array(WebSearchProviderSchema).optional(),
    settings: z.record(WebSearchProviderSettingsSchema).optional(),
  })
  .passthrough();

/**
 * Local speech-to-text is opt-in. The runtime never downloads binaries/models
 * or forwards audio to a cloud provider implicitly; an operator must provide
 * an official whisper.cpp endpoint or executable/model pair.
 */
export const SpeechToTextModelSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    name: z.string().min(1).max(120),
    transport: z.enum(["endpoint", "cli"]),
    enabled: z.boolean().default(true),
    endpoint: z.string().url().optional(),
    executable: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .passthrough();

export const SpeechToTextSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.literal("whisper.cpp").default("whisper.cpp"),
    endpoint: z.string().url().optional(),
    executable: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    active_model_id: z.string().min(1).optional(),
    models: z.array(SpeechToTextModelSchema).default([]),
    language: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]{0,19}$/)
      .default("auto"),
    max_audio_seconds: z.number().int().min(1).max(3600).default(300),
    max_file_mb: z.number().int().min(1).max(50).default(25),
    timeout_ms: z.number().int().min(1000).max(300000).default(120000),
    concurrency: z.number().int().min(1).max(4).default(1),
    retain_audio: z.boolean().default(false),
  })
  .passthrough();

export type SpeechToTextModel = z.infer<typeof SpeechToTextModelSchema>;
export type SpeechToTextSettings = z.infer<typeof SpeechToTextSchema>;

const AgentResourceSchema = z
  .object({
    mode: z.enum(["eco", "balanced", "performance"]).optional(),
    message_history_limit: z.number().int().min(1).max(50).optional(),
    web_search_max_calls_per_turn: z.number().int().min(1).max(5).optional(),
    max_context_chars: z.number().int().min(8000).max(200000).optional(),
    system_index_limit: z.number().int().min(0).max(20).optional(),
    system_index_cache_ttl_ms: z.number().int().min(0).max(300000).optional(),
    tool_warmup_enabled: z.boolean().optional(),
    quality_retry_limit: z.number().int().min(0).max(5).optional(),
  })
  .passthrough();

const AgentMemorySchema = z
  .object({
    short_term_limit: z.number().int().min(1).max(200).optional(),
    long_term_enabled: z.boolean().optional(),
    auto_summarize: z.boolean().optional(),
    message_retention_days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .nullable()
      .optional(),
    vector_search_threshold: z.number().min(0).max(1).optional(),
    consolidation_batch_size: z.number().int().min(1).max(100).optional(),
    consolidation_debounce_ms: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .optional(),
    max_context_memories: z.number().int().min(0).max(30).optional(),
    max_context_facts: z.number().int().min(0).max(30).optional(),
    max_context_chars: z.number().int().min(500).max(50000).optional(),
    prune_low_value_facts: z.boolean().optional(),
    fact_prune_threshold: z.number().min(0).max(1).optional(),
    fact_prune_min_age_days: z.number().int().min(1).max(3650).optional(),
  })
  .passthrough();

const AgentBlockSchema = z
  .object({
    name: z.string().min(1).optional(),
    project: z.string().optional(),
    persona: z.string().optional(),
    language: z.string().optional(),
    timezone: z.string().optional(),
    max_tokens_per_cycle: z.number().int().min(100).max(100000).optional(),
    browser: z
      .object({
        max_retries: z.number().int().min(0).max(10).optional(),
        clear_state_every_n_navigations: z.number().int().min(1).optional(),
        chrome_path: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    resource: AgentResourceSchema.optional(),
    memory: AgentMemorySchema.optional(),
    security: z
      .object({
        // Safe-by-default: omit security.* only when the runtime should
        // remain workspace-scoped and sandboxed. Unrestricted access must be
        // an explicit operator choice, never an implicit default.
        bypass_restrictions: z.boolean().default(false),
        system_access: z
          .enum(["full", "workspace_only", "isolated"])
          .default("workspace_only"),
        sandbox_mode: z.boolean().default(true),
        risk_acceptance: z.boolean().optional(),
        privileged_account_required: z.boolean().optional(),
        audit_logging: z.boolean().optional(),
        approval_note: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const BehaviorLearningSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(["observe", "draft", "apply"]).default("draft"),
    exploration_rate: z.number().min(0).max(1).default(0.1),
    min_samples: z.number().int().min(1).max(1000).default(3),
    max_draft_notes: z.number().int().min(0).max(50).default(3),
  })
  .passthrough();

export const RuntimeConfigSchema = z
  .object({
    schema_version: z.number().int().min(1).optional(),
    agent: AgentBlockSchema.optional(),
    self_improvement: z
      .object({
        enabled: z.boolean().optional(),
        reflection_interval_minutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional(),
        optimization_interval_minutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional(),
        prompt_tuning_interval_minutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional(),
        max_daily_reflections: z.number().int().min(1).max(100).optional(),
        max_reflections_per_day: z.number().int().min(1).max(100).optional(),
        auto_apply_optimizations: z.boolean().optional(),
        drift_threshold: z.number().min(0).max(1).optional(),
        guardrails: z
          .object({
            enabled: z.boolean().optional(),
            max_prompt_drift_percent: z.number().min(1).max(100).optional(),
          })
          .passthrough()
          .optional(),
        behavior_learning: BehaviorLearningSchema.default({}),
      })
      .passthrough()
      .optional(),
    concurrency: z
      .object({
        maxConcurrentTasks: z.number().int().min(1).max(100).optional(),
        maxParallelToolCalls: z.number().int().min(1).max(100).optional(),
        toolLockTimeoutMs: z.number().int().min(1000).max(300000).optional(),
        taskQueueSize: z.number().int().min(1).max(1000).optional(),
        schedulerIntervalMs: z.number().int().min(10).max(60000).optional(),
        maxScheduledTaskAttempts: z.number().int().min(1).max(20).optional(),
        retryBaseDelayMs: z.number().int().min(100).max(3600000).optional(),
        retryMaxDelayMs: z.number().int().min(100).max(86400000).optional(),
        recoveryStaleAfterMs: z
          .number()
          .int()
          .min(1000)
          .max(86400000)
          .optional(),
      })
      .passthrough()
      .optional(),
    heartbeat: JsonRecordSchema.optional(),
    skill_governance: JsonRecordSchema.optional(),
    agents: JsonRecordSchema.optional(),
    session: JsonRecordSchema.optional(),
    evolution: JsonRecordSchema.optional(),
    tools: JsonRecordSchema.optional(),
    models: z.array(JsonRecordSchema).optional(),
    model_providers: JsonRecordSchema.optional(),
    devices: JsonRecordSchema.optional(),
    channels: JsonRecordSchema.optional(),
    channel_list: JsonRecordSchema.optional(),
    web_search: WebSearchSchema.optional(),
    speech_to_text: SpeechToTextSchema.optional(),
  })
  .extend({
    tools: ToolsSchema.optional(),
  })
  .passthrough();

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export interface ConfigValidationIssue {
  path: string;
  message: string;
  code: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  config: RuntimeConfig;
  errors: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
}

export interface RuntimeConfigValidationOptions {
  allowedChannelNames?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function issue(
  path: string,
  message: string,
  code: string,
): ConfigValidationIssue {
  return { path, message, code };
}

export function migrateRuntimeConfig(
  input: Record<string, unknown>,
): RuntimeConfig {
  const migrated = cloneRecord(input);
  migrated.schema_version = CURRENT_CONFIG_SCHEMA_VERSION;

  const agent = isRecord(migrated.agent) ? migrated.agent : {};
  for (const key of [
    "heartbeat",
    "self_improvement",
    "skill_governance",
    "concurrency",
  ]) {
    if (!migrated[key] && isRecord(agent[key])) {
      migrated[key] = agent[key];
    }
  }

  if (
    isRecord(migrated.heartbeat) &&
    migrated.heartbeat.interval_seconds == null &&
    typeof migrated.heartbeat.interval === "number"
  ) {
    migrated.heartbeat.interval_seconds = migrated.heartbeat.interval;
  }

  const agents = isRecord(migrated.agents) ? migrated.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  if (typeof defaults.max_tokens === "number") {
    migrated.agent = {
      ...agent,
      max_tokens_per_cycle:
        typeof agent.max_tokens_per_cycle === "number"
          ? agent.max_tokens_per_cycle
          : defaults.max_tokens,
    };
  } else if (Object.keys(agent).length > 0) {
    migrated.agent = agent;
  }

  return migrated as RuntimeConfig;
}

export function validateRuntimeConfig(
  input: Record<string, unknown>,
  options: RuntimeConfigValidationOptions = {},
): ConfigValidationResult {
  const config = migrateRuntimeConfig(input);
  const parsed = RuntimeConfigSchema.safeParse(config);
  const errors: ConfigValidationIssue[] = [];
  const warnings: ConfigValidationIssue[] = [];

  if (!parsed.success) {
    for (const item of parsed.error.issues) {
      errors.push(issue(item.path.join(".") || "$", item.message, item.code));
    }
  }

  const knownKeys = new Set([
    "schema_version",
    "agent",
    "self_improvement",
    "concurrency",
    "heartbeat",
    "skill_governance",
    "agents",
    "session",
    "evolution",
    "tools",
    "models",
    "model_providers",
    "devices",
    "channels",
    "channel_list",
    "web_search",
    "speech_to_text",
  ]);
  for (const key of Object.keys(config)) {
    if (!knownKeys.has(key)) {
      warnings.push(
        issue(key, "Unknown top-level configuration key.", "unknown_key"),
      );
    }
  }

  const allowedChannelNames = new Set([
    ...SUPPORTED_CHANNEL_NAMES,
    ...(options.allowedChannelNames || []),
  ]);
  validateChannelMap("channels", config.channels, errors, allowedChannelNames);
  validateChannelMap(
    "channel_list",
    config.channel_list,
    errors,
    allowedChannelNames,
  );
  validateMcpServers(config, errors);
  validateMqttBrokerConfig(config, errors);
  validateWebSearchConfig(config, errors);
  validateSpeechToTextConfig(config, errors);
  return {
    valid: errors.length === 0,
    config: parsed.success ? parsed.data : config,
    errors,
    warnings,
  };
}

function validateChannelMap(
  pathPrefix: string,
  value: unknown,
  errors: ConfigValidationIssue[],
  allowedChannelNames: Set<string>,
): void {
  if (!isRecord(value)) return;
  for (const [name, channelConfig] of Object.entries(value)) {
    if (!allowedChannelNames.has(name)) {
      errors.push(
        issue(
          `${pathPrefix}.${name}`,
          `Unsupported channel name "${name}".`,
          "unsupported_channel",
        ),
      );
    }
    if (!isRecord(channelConfig)) {
      errors.push(
        issue(
          `${pathPrefix}.${name}`,
          "Channel configuration must be an object.",
          "invalid_channel_config",
        ),
      );
    }
  }
}

function validateMqttBrokerConfig(
  config: RuntimeConfig,
  errors: ConfigValidationIssue[],
): void {
  const channelMaps = [config.channels, config.channel_list];
  for (const channelMap of channelMaps) {
    if (!isRecord(channelMap)) continue;
    const rawChannel = channelMap.mqtt;
    if (!isRecord(rawChannel)) continue;
    const settings = isRecord(rawChannel.settings) ? rawChannel.settings : {};
    const broker = stringValue(settings.broker ?? rawChannel.broker);
    const enabled = rawChannel.enabled === true;
    if (!broker) {
      if (enabled) {
        errors.push(
          issue(
            "channels.mqtt.broker",
            "Enabled MQTT channels require a broker URL.",
            "missing_mqtt_broker",
          ),
        );
      }
      continue;
    }
    try {
      const parsed = new URL(broker);
      const allowedProtocol = new Set(["mqtt:", "mqtts:", "ssl:", "tcp:"]).has(
        parsed.protocol,
      );
      const validPort =
        !parsed.port ||
        (Number.isInteger(Number(parsed.port)) &&
          Number(parsed.port) >= 1 &&
          Number(parsed.port) <= 65_535);
      if (!allowedProtocol || !parsed.hostname || !validPort) {
        errors.push(
          issue(
            "channels.mqtt.broker",
            "MQTT broker must use mqtt://, mqtts://, ssl://, or tcp:// with a valid host and port.",
            "invalid_mqtt_broker",
          ),
        );
      }
    } catch {
      errors.push(
        issue(
          "channels.mqtt.broker",
          "MQTT broker must use mqtt://, mqtts://, ssl://, or tcp:// with a valid host and port.",
          "invalid_mqtt_broker",
        ),
      );
    }
  }
}

function validateMcpServers(
  config: RuntimeConfig,
  errors: ConfigValidationIssue[],
): void {
  const tools = isRecord(config.tools) ? config.tools : {};
  const mcp = isRecord(tools.mcp) ? tools.mcp : {};
  const discovery = isRecord(mcp.discovery) ? mcp.discovery : {};
  if (
    discovery.enabled === true &&
    discovery.use_bm25 === false &&
    discovery.use_regex === false
  ) {
    errors.push(
      issue(
        "tools.mcp.discovery",
        "MCP discovery requires at least one search method.",
        "mcp_discovery_without_search_method",
      ),
    );
  }

  const servers = isRecord(mcp.servers) ? mcp.servers : {};
  for (const [name, rawServer] of Object.entries(servers)) {
    if (!isRecord(rawServer)) {
      errors.push(
        issue(
          `tools.mcp.servers.${name}`,
          "MCP server definition must be an object.",
          "invalid_mcp_server",
        ),
      );
      continue;
    }
    const server = rawServer as Record<string, unknown>;
    const enabled = server.enabled !== false;
    const type = String(server.type || (server.url ? "sse" : "stdio"));
    if (enabled && type === "stdio" && !stringValue(server.command)) {
      errors.push(
        issue(
          `tools.mcp.servers.${name}.command`,
          "Enabled stdio MCP servers require a command.",
          "missing_mcp_command",
        ),
      );
    }
    if (enabled && type !== "stdio") {
      const url = stringValue(server.url);
      if (!url || !isHttpUrl(url)) {
        errors.push(
          issue(
            `tools.mcp.servers.${name}.url`,
            "Enabled HTTP/SSE MCP servers require a valid HTTP(S) URL.",
            "invalid_mcp_url",
          ),
        );
      } else if (urlHasCredentials(url)) {
        errors.push(
          issue(
            `tools.mcp.servers.${name}.url`,
            "MCP server URLs must not contain embedded credentials.",
            "mcp_server_url_userinfo",
          ),
        );
      }
    }
    const env = isRecord(server.env) ? server.env : {};
    for (const key of Object.keys(env)) {
      if (UNSAFE_MCP_ENV_KEYS.has(key.toUpperCase())) {
        errors.push(
          issue(
            `tools.mcp.servers.${name}.env.${key}`,
            "This environment variable is blocked for MCP server definitions.",
            "unsafe_mcp_env_key",
          ),
        );
      }
    }
  }
}

function validateWebSearchConfig(
  config: RuntimeConfig,
  errors: ConfigValidationIssue[],
): void {
  if (!isRecord(config.web_search)) return;
  const webSearch = config.web_search;
  for (const key of ["provider", "current_service"]) {
    const value = stringValue(webSearch[key]);
    if (value && !SUPPORTED_WEB_SEARCH_PROVIDERS.has(value)) {
      errors.push(
        issue(
          `web_search.${key}`,
          `Unsupported web search provider "${value}".`,
          "unsupported_web_search_provider",
        ),
      );
    }
  }

  const providers = Array.isArray(webSearch.providers)
    ? webSearch.providers
    : [];
  for (const [index, provider] of providers.entries()) {
    if (!isRecord(provider)) continue;
    const id = stringValue(provider.id);
    if (id && !SUPPORTED_WEB_SEARCH_PROVIDERS.has(id)) {
      errors.push(
        issue(
          `web_search.providers.${index}.id`,
          `Unsupported web search provider "${id}".`,
          "unsupported_web_search_provider",
        ),
      );
    }
  }

  const settings = isRecord(webSearch.settings) ? webSearch.settings : {};
  for (const providerId of Object.keys(settings)) {
    if (!SUPPORTED_WEB_SEARCH_PROVIDERS.has(providerId)) {
      errors.push(
        issue(
          `web_search.settings.${providerId}`,
          `Unsupported web search provider "${providerId}".`,
          "unsupported_web_search_provider",
        ),
      );
    }
  }
}

function validateSpeechToTextConfig(
  config: RuntimeConfig,
  errors: ConfigValidationIssue[],
): void {
  if (!isRecord(config.speech_to_text)) return;
  const speech = config.speech_to_text;
  if (speech.enabled !== true) return;
  const models = Array.isArray(speech.models) ? speech.models : [];
  const modelIds = new Set<string>();
  for (const [index, item] of models.entries()) {
    if (!isRecord(item)) continue;
    const id = stringValue(item.id);
    if (id && modelIds.has(id)) {
      errors.push(
        issue(
          `speech_to_text.models.${index}.id`,
          `Speech model id "${id}" is duplicated.`,
          "duplicate_speech_to_text_model_id",
        ),
      );
    }
    if (id) modelIds.add(id);
    const transport = stringValue(item.transport);
    const itemEndpoint = stringValue(item.endpoint);
    const itemExecutable = stringValue(item.executable);
    const itemModel = stringValue(item.model);
    if (
      transport === "endpoint" &&
      (!itemEndpoint || itemExecutable || itemModel)
    ) {
      errors.push(
        issue(
          `speech_to_text.models.${index}`,
          "Endpoint speech models require endpoint only.",
          "invalid_speech_to_text_model",
        ),
      );
    }
    if (
      transport === "cli" &&
      (!itemExecutable || !itemModel || itemEndpoint)
    ) {
      errors.push(
        issue(
          `speech_to_text.models.${index}`,
          "CLI speech models require executable and model paths only.",
          "invalid_speech_to_text_model",
        ),
      );
    }
    if (itemEndpoint && !isHttpUrl(itemEndpoint)) {
      errors.push(
        issue(
          `speech_to_text.models.${index}.endpoint`,
          "Speech-to-text endpoint must use http:// or https://.",
          "invalid_speech_to_text_endpoint",
        ),
      );
    }
  }
  const activeModelId = stringValue(speech.active_model_id);
  if (activeModelId && !modelIds.has(activeModelId)) {
    errors.push(
      issue(
        "speech_to_text.active_model_id",
        "The selected speech model does not exist.",
        "unknown_speech_to_text_model",
      ),
    );
  }
  const activeModel = models.find(
    (item) =>
      isRecord(item) && item.id === activeModelId && item.enabled !== false,
  );
  const endpoint = stringValue(activeModel?.endpoint ?? speech.endpoint);
  const executable = stringValue(activeModel?.executable ?? speech.executable);
  const model = stringValue(activeModel?.model ?? speech.model);
  if (!endpoint && !(executable && model)) {
    errors.push(
      issue(
        "speech_to_text",
        "Enabled speech-to-text requires an HTTP endpoint or both executable and model paths.",
        "missing_speech_to_text_runtime",
      ),
    );
    return;
  }
  if (endpoint && !isHttpUrl(endpoint)) {
    errors.push(
      issue(
        "speech_to_text.endpoint",
        "Speech-to-text endpoint must use http:// or https://.",
        "invalid_speech_to_text_endpoint",
      ),
    );
  }
  if (endpoint && (executable || model)) {
    errors.push(
      issue(
        "speech_to_text",
        "Configure either endpoint or executable+model, not both.",
        "ambiguous_speech_to_text_runtime",
      ),
    );
  }
}
function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function urlHasCredentials(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

export function assertRuntimeConfig(
  input: Record<string, unknown>,
): RuntimeConfig {
  const result = validateRuntimeConfig(input);
  if (!result.valid) {
    throw new Error(
      `Invalid runtime config: ${result.errors
        .map((item) => `${item.path}: ${item.message}`)
        .join("; ")}`,
    );
  }
  return result.config;
}
