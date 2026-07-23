import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import * as crypto from "crypto";
import * as child_process from "child_process";
import * as fs from "fs";
import type { IncomingHttpHeaders } from "http";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import QRCode from "qrcode";

function positiveIntFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

import {
  createWorkspaceSecretVault,
  inspectEnvSecretStatus,
  isSecretEnvKey,
  loadVaultSecretsIntoEnv,
  migrateEnvSecretsToVault,
  redactSecrets,
  resolveEnvSecret,
  setEnvSecret,
  settings,
  validateRuntimeConfig,
  type ConfigValidationResult,
  type SecretVault,
} from "@hiro/config";

import type { AgentOrchestrator } from "../agent.js";
import type { SkillLoader } from "../skill-loader.js";
import type { SkillMetadata } from "../skill-search.js";
import { getSystemStats } from "./system-monitoring.js";
import { createFileManagerRouter } from "./file-manager-router.js";
import {
  litellmBaseUrlFromEnv,
  litellmConfigPath,
  writeLiteLLMConfig,
} from "../litellm-config.js";
import {
  canRunDashboardSetup,
  dashboardAccessDecision,
  isAuthInitialized,
  validateOneTimeBootstrapToken,
  type StoredAuth,
} from "./launcher-auth-guards.js";
import {
  buildChannelRuntimeProbe,
  configuredSecretsForChannel,
  flattenChannelConfig,
  type ChannelProbeMode,
  type ChannelRuntimeProbeCheck,
  type SupportedChannelMetadata,
} from "./channel-runtime-probe.js";
import {
  getSessionPermissionState,
  getSessionPermissions,
  setSessionPermissions,
} from "../mcp/permissions/session-permissions.js";
import {
  findRuntimePluginChannelDescriptor,
  listRuntimePluginChannelMetadata,
  probeRuntimePluginChannel,
  type RuntimePluginChannelDescriptor,
} from "../plugins/plugin-channel-adapter.js";
import { buildPluginMarketplaceReadinessReport } from "../plugins/plugin-marketplace-readiness.js";
import { listRuntimePluginProviderMetadata } from "../plugins/plugin-provider-adapter.js";
import { summarizeAgentRoute } from "../agent-router.js";
import {
  buildWorkflowAccelerationPlan,
  buildWorkflowDecisionPattern,
} from "../workflow-accelerator.js";
import { resolveLiteLLMMasterKey } from "@hiro/config/security";
import { type RuntimePaths } from "../paths.js";

type JsonRecord = Record<string, unknown>;

type QrBindingChannel = "weixin" | "wecom";
type QrBindingStatus = "wait" | "scaned" | "confirmed" | "expired" | "error";

interface QrBindingFlow {
  id: string;
  channel: QrBindingChannel;
  status: QrBindingStatus;
  qrDataURI?: string;
  qrcode?: string;
  scode?: string;
  accountId?: string;
  botId?: string;
  error?: string;
  pollBaseURL?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface QrBindingFlowResponse {
  flow_id: string;
  status: QrBindingStatus;
  qr_data_uri?: string;
  account_id?: string;
  bot_id?: string;
  error?: string;
}

interface WeixinQrResponse {
  errcode?: number;
  errmsg?: string;
  qrcode?: string;
  qrcode_img_content?: string;
}

interface WeixinQrStatusResponse {
  errcode?: number;
  errmsg?: string;
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

interface WecomQrGenerateResponse {
  errcode?: number;
  errmsg?: string;
  data?: {
    scode?: string;
    auth_url?: string;
  };
}

interface WecomQrQueryResponse {
  errcode?: number;
  errmsg?: string;
  data?: {
    status?: string;
    bot_info?: {
      botid?: string;
      secret?: string;
    };
  };
}

const QR_BINDING_FLOW_TTL_MS = 5 * 60 * 1000;
const QR_BINDING_FLOW_GC_MS = 30 * 60 * 1000;
const WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const WEIXIN_BOT_TYPE = "3";
const WECOM_QR_SOURCE_ID = "Hiro";
const WECOM_QR_GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate";
const WECOM_QR_QUERY_URL = "https://work.weixin.qq.com/ai/qc/query_result";
const WECOM_DEFAULT_WEBSOCKET_URL = "wss://openws.work.weixin.qq.com";

type ResolvedChannel =
  | {
      source: "builtin";
      channel: SupportedChannelMetadata;
      secretFields: string[];
    }
  | {
      source: "plugin";
      channel: SupportedChannelMetadata;
      descriptor: RuntimePluginChannelDescriptor;
      secretFields: string[];
    };

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
  hiro: ["token"],
  matrix: ["access_token"],
  irc: ["password", "nickserv_password", "sasl_password"],
  mqtt: ["username", "password"],
};

const CHANNEL_SECRET_ENV_KEYS: Record<string, Record<string, string>> = {
  telegram: { token: "TELEGRAM_BOT_TOKEN" },
  discord: { token: "DISCORD_BOT_TOKEN" },
  slack: {
    bot_token: "SLACK_BOT_TOKEN",
    app_token: "SLACK_APP_TOKEN",
  },
  feishu: {
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
  qq: { token: "QQ_BOT_TOKEN" },
  onebot: { access_token: "ONEBOT_ACCESS_TOKEN" },
  whatsapp: { webhook_token: "WHATSAPP_WEBHOOK_TOKEN" },
  weixin: {
    token: "WEIXIN_TOKEN",
    encoding_aes_key: "WEIXIN_ENCODING_AES_KEY",
  },
  wecom: {
    secret: "WECOM_SECRET",
    corp_secret: "WECOM_CORP_SECRET",
    webhook_url: "WECOM_WEBHOOK_URL",
  },
  matrix: { access_token: "MATRIX_ACCESS_TOKEN" },
  irc: {
    password: "IRC_PASSWORD",
    nickserv_password: "IRC_NICKSERV_PASSWORD",
    sasl_password: "IRC_SASL_PASSWORD",
  },
  mqtt: {
    username: "MQTT_USERNAME",
    password: "MQTT_PASSWORD",
  },
};

const SECRET_REF_FIELD_PATTERN =
  /(?:api[_-]?key|token|secret|password|credential|authorization)/i;

interface ProviderModelsResponse {
  data?: unknown[];
  models?: unknown[];
}

interface ProviderModelResult {
  id: string;
  owned_by?: string;
  extra?: JsonRecord;
}

type LauncherSkillMetadata = SkillMetadata & {
  registry_name?: string;
  registry_url?: string;
  installed_at?: string;
};

interface LauncherCompatOptions {
  orchestrator: AgentOrchestrator;
  skillLoader: SkillLoader;
  /** @deprecated Use runtimePaths instead */
  workspaceDir?: string;
  runtimePaths: RuntimePaths;
  reloadRuntime?: (request?: RuntimeReloadRequest) => Promise<void> | void;
  registerRuntimeAuth?: (runtimeAuth: LauncherRuntimeAuthBridge) => void;
}

export interface LauncherRuntimeAuthBridge {
  isDashboardAuthenticated(headers: IncomingHttpHeaders): boolean;
  gethiroToken(): string | undefined;
  ensurehiroToken(): string;
}

export type RuntimeApplyStatus = "applied" | "pending_restart" | "failed";

export interface RuntimeReloadRequest {
  channelsChanged?: string[];
  reason?: string;
}

export interface RuntimeApplyResult {
  status: RuntimeApplyStatus;
  applied: boolean;
  pending_restart: boolean;
  gateway_restart_required: boolean;
  pending_restart_fields?: string[];
  error?: string;
}

type FlowComponentStatus = "ready" | "partial" | "disabled" | "error";

interface FlowComponent {
  id: string;
  label: string;
  status: FlowComponentStatus;
  summary: string;
  evidence: string[];
  metrics?: Record<string, number | string | boolean>;
}

interface FlowGap {
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail: string;
  owner: string;
}

interface FlowStatusResponse {
  status: FlowComponentStatus;
  generated_at: string;
  flow_version: 1;
  components: FlowComponent[];
  edges: Array<{ from: string; to: string; contract: string }>;
  gaps: FlowGap[];
}

interface StoredModel {
  model_name: string;
  provider?: string;
  model?: string;
  api_base?: string;
  proxy?: string;
  auth_method?: string;
  enabled?: boolean;
  connect_mode?: string;
  workspace?: string;
  rpm?: number;
  max_tokens_field?: string;
  request_timeout?: number;
  thinking_level?: string;
  tool_schema_transform?: string;
  streaming?: { enabled?: boolean };
  extra_body?: JsonRecord;
  custom_headers?: Record<string, string>;
}

interface ProviderOption {
  id: string;
  display_name?: string;
  icon_slug?: string;
  domain?: string;
  default_api_base: string;
  empty_api_key_allowed: boolean;
  create_allowed: boolean;
  default_model_allowed: boolean;
  supports_fetch?: boolean;
  default_auth_method?: string;
  auth_method_locked?: boolean;
  local?: boolean;
  priority?: number;
  common_models?: string[];
  aliases?: string[];
  source?: "builtin" | "plugin";
}

interface CatalogEntry {
  id: string;
  provider: string;
  api_base: string;
  api_key_mask: string;
  models: Array<{ id: string; owned_by?: string; extra?: JsonRecord }>;
  fetched_at: string;
}

interface CompatState {
  config?: JsonRecord;
  launcher_config?: {
    port: number;
    public: boolean;
    allowed_cidrs: string[];
  };
  autostart?: {
    enabled: boolean;
  };
  auth?: StoredAuth;
  models?: StoredModel[];
  model_catalog?: CatalogEntry[];
  tool_state?: Record<string, boolean>;
  web_search?: JsonRecord;
  oauth?: Record<string, JsonRecord>;
  hiro_token?: string;
  gateway_restart_required?: boolean;
  runtime_apply_status?: RuntimeApplyStatus;
  runtime_apply_error?: string;
  pending_restart_fields?: string[];
}

interface LiteLLMRuntimeStatus {
  configured: boolean;
  healthy: boolean;
  status: "healthy" | "unreachable" | "unconfigured";
  base_url: string;
  config_path: string;
  config_exists: boolean;
  log_path: string;
  model_count: number;
  models: Array<{
    modelName: string;
    litellmModel: string;
    provider: string;
  }>;
  models_endpoint_count?: number;
  error?: string;
  gateway_restart_required?: boolean;
}

const AUTH_COOKIE = "Hiro_dashboard_session";
const AUTH_COOKIE_MAX_AGE_SECONDS = 31 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_LOGINS = 8;
const activeSessions = new Map<string, number>();
const loginFailures = new Map<string, { count: number; resetAt: number }>();

const CHANNEL_RUNTIME_NOTES = {
  hiro: "Verified WebUI chat path through the gateway WebSocket proxy.",
  telegram: "Node Telegram adapter exists; requires a valid bot token.",
  discord:
    "Node Discord Gateway adapter supports inbound messages, outbound replies, filtering, reconnect, and API error surfacing.",
  slack:
    "Node Slack Socket Mode adapter supports events, acknowledgements, threaded replies, filtering, reconnect, and API error surfacing.",
  line: "Node LINE webhook adapter verifies signatures, filters events, and sends bounded replies.",
  feishu:
    "Node Feishu/Lark webhook adapter supports token-verified callbacks, URL verification, inbound text events, bounded replies, filtering, and API error surfacing.",
  dingtalk:
    "Node DingTalk webhook adapter supports signed robot webhooks, inbound text events, outbound robot replies, filtering, and API error surfacing.",
  qq: "Node QQ webhook adapter supports inbound message callbacks, bounded outbound replies, filtering, and API error surfacing.",
  matrix:
    "Node Matrix sync adapter supports sync polling, outbound room messages, filtering, and retry.",
  irc: "Node IRC socket adapter supports TLS/plain sockets, joins, mentions, DMs, outbound replies, and reconnect.",
  onebot:
    "Node OneBot v11 adapter supports WebSocket inbound events, HTTP replies, filtering, mentions, and reconnect.",
  mqtt: "Node MQTT 3.1.1 adapter supports broker auth, request/response topics, QoS 0/1 packets, keepalive, and reconnect.",
  whatsapp:
    "Node WhatsApp bridge adapter verifies shared tokens, parses common bridge payloads, filters events, and sends bounded outbound replies.",
  partial:
    "Configuration is stored, but the default Node gateway does not currently prove an end-to-end bot runtime for this channel.",
} as const;

export const SUPPORTED_CHANNELS: SupportedChannelMetadata[] = [
  {
    name: "telegram",
    display_name: "Telegram",
    config_key: "telegram",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.telegram,
  },
  {
    name: "discord",
    display_name: "Discord",
    config_key: "discord",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.discord,
  },
  {
    name: "slack",
    display_name: "Slack",
    config_key: "slack",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.slack,
  },
  {
    name: "feishu",
    display_name: "Feishu",
    config_key: "feishu",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.feishu,
  },
  {
    name: "dingtalk",
    display_name: "DingTalk",
    config_key: "dingtalk",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.dingtalk,
  },
  {
    name: "qq",
    display_name: "QQ",
    config_key: "qq",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.qq,
  },
  {
    name: "weixin",
    display_name: "WeChat",
    config_key: "weixin",
    runtime_status: "functional",
    runtime_note:
      "WeChat flow/webhook runtime has mock-send readiness coverage.",
  },
  {
    name: "wecom",
    display_name: "WeCom",
    config_key: "wecom",
    runtime_status: "functional",
    runtime_note:
      "WeCom flow/webhook runtime has mock-send readiness coverage.",
  },
  {
    name: "line",
    display_name: "LINE",
    config_key: "line",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.line,
  },
  {
    name: "onebot",
    display_name: "OneBot",
    config_key: "onebot",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.onebot,
  },
  {
    name: "whatsapp",
    display_name: "WhatsApp",
    config_key: "whatsapp",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.whatsapp,
  },
  {
    name: "hiro",
    display_name: "hiro",
    config_key: "hiro",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.hiro,
  },
  {
    name: "matrix",
    display_name: "Matrix",
    config_key: "matrix",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.matrix,
  },
  {
    name: "irc",
    display_name: "IRC",
    config_key: "irc",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.irc,
  },
  {
    name: "mqtt",
    display_name: "MQTT",
    config_key: "mqtt",
    runtime_status: "functional",
    runtime_note: CHANNEL_RUNTIME_NOTES.mqtt,
  },
];

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: "openai",
    display_name: "OpenAI",
    icon_slug: "openai",
    domain: "openai.com",
    default_api_base: "https://api.openai.com/v1",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: true,
    default_auth_method: "api_key",
    priority: 100,
    common_models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"],
    aliases: ["openai"],
  },
  {
    id: "anthropic",
    display_name: "Anthropic",
    icon_slug: "anthropic",
    domain: "anthropic.com",
    default_api_base: "https://api.anthropic.com/v1",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: false,
    default_auth_method: "api_key",
    priority: 90,
    common_models: [
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
    ],
    aliases: ["claude"],
  },
  {
    id: "google",
    display_name: "Google Gemini",
    icon_slug: "google",
    domain: "ai.google.dev",
    default_api_base:
      "https://generativelanguage.googleapis.com/v1beta/openai/",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: true,
    default_auth_method: "api_key",
    priority: 80,
    common_models: ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
    aliases: ["gemini"],
  },
  {
    id: "openrouter",
    display_name: "OpenRouter",
    icon_slug: "openrouter",
    domain: "openrouter.ai",
    default_api_base: "https://openrouter.ai/api/v1",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: true,
    default_auth_method: "api_key",
    priority: 70,
    common_models: [
      "anthropic/claude-3.5-sonnet",
      "openai/gpt-4o",
      "google/gemini-2.0-flash",
      "meta-llama/llama-3.1-405b",
    ],
    aliases: ["open-router"],
  },
  {
    id: "deepseek",
    display_name: "DeepSeek",
    icon_slug: "deepseek",
    domain: "deepseek.com",
    default_api_base: "https://api.deepseek.com/v1",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: true,
    default_auth_method: "api_key",
    priority: 60,
    common_models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "azure",
    display_name: "Azure OpenAI",
    icon_slug: "azure",
    domain: "azure.microsoft.com",
    default_api_base: "",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: false,
    default_auth_method: "api_key",
    priority: 55,
    common_models: [],
  },
  {
    id: "ollama",
    display_name: "Ollama",
    icon_slug: "ollama",
    domain: "ollama.com",
    default_api_base: "http://127.0.0.1:11434/v1",
    empty_api_key_allowed: true,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: true,
    default_auth_method: "none",
    local: true,
    priority: 50,
    common_models: ["llama3.1", "llama3.2", "mistral", "qwen2.5"],
  },
  {
    id: "vllm",
    display_name: "vLLM",
    icon_slug: "server",
    default_api_base: "http://127.0.0.1:8001/v1",
    empty_api_key_allowed: true,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: true,
    default_auth_method: "none",
    local: true,
    priority: 45,
    common_models: [],
  },
  {
    id: "lmstudio",
    display_name: "LM Studio",
    icon_slug: "server",
    default_api_base: "http://127.0.0.1:1234/v1",
    empty_api_key_allowed: true,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: true,
    default_auth_method: "none",
    local: true,
    priority: 44,
    common_models: [],
  },
  {
    id: "claude-cli",
    display_name: "Claude CLI",
    icon_slug: "terminal",
    default_api_base: "",
    empty_api_key_allowed: true,
    create_allowed: true,
    default_model_allowed: false,
    supports_fetch: false,
    default_auth_method: "cli",
    local: true,
    priority: 30,
    common_models: ["claude-cli"],
  },
  {
    id: "codex-cli",
    display_name: "Codex CLI",
    icon_slug: "terminal",
    default_api_base: "",
    empty_api_key_allowed: true,
    create_allowed: true,
    default_model_allowed: false,
    supports_fetch: false,
    default_auth_method: "cli",
    local: true,
    priority: 30,
    common_models: ["codex-cli"],
  },
  {
    id: "github-copilot",
    display_name: "GitHub Copilot",
    icon_slug: "github",
    default_api_base: "",
    empty_api_key_allowed: true,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: false,
    default_auth_method: "cli",
    local: true,
    priority: 25,
    common_models: ["github-copilot/gpt-4o"],
  },
  {
    id: "bedrock",
    display_name: "Amazon Bedrock",
    icon_slug: "aws",
    default_api_base: "",
    empty_api_key_allowed: true,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: false,
    default_auth_method: "aws",
    priority: 20,
    common_models: [],
  },
  {
    id: "elevenlabs",
    display_name: "ElevenLabs",
    icon_slug: "elevenlabs",
    default_api_base: "https://api.elevenlabs.io/v1",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: false,
    supports_fetch: false,
    default_auth_method: "api_key",
    priority: 10,
    common_models: [],
  },
];

const WEB_SEARCH_DEFAULT = {
  provider: "native",
  current_service: "native",
  prefer_native: true,
  providers: [
    {
      id: "native",
      label: "Native Web Search",
      configured: true,
      current: true,
      requires_auth: false,
    },
    {
      id: "tavily",
      label: "Tavily",
      configured: false,
      current: false,
      requires_auth: true,
    },
    {
      id: "serpapi",
      label: "SerpAPI",
      configured: false,
      current: false,
      requires_auth: true,
    },
  ],
  settings: {
    native: { enabled: true, max_results: 5 },
    tavily: { enabled: false, max_results: 5, api_key_set: false },
    serpapi: { enabled: false, max_results: 5, api_key_set: false },
  },
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSecretRef(value: unknown): value is { secret_ref: string } {
  return (
    isRecord(value) &&
    typeof value.secret_ref === "string" &&
    value.secret_ref.trim() !== ""
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function channelSecretName(channelName: string, field: string): string {
  return `channels/${channelName}/${field}`;
}

function setRuntimeSecret(
  vault: SecretVault,
  configDir: string,
  secretName: string,
  value: string,
  envKey?: string,
): void {
  vault.set(secretName, value);
  if (envKey) {
    setEnvSecret(envKey, value, configDir);
  }
}

function runtimeSecretConfigured(
  vault: SecretVault,
  secretName: string,
  envKey?: string,
): boolean {
  try {
    if (vault.get(secretName)) return true;
  } catch {
    return false;
  }
  return Boolean(envKey && resolveEnvSecret(envKey));
}

function runtimeSecretValue(
  vault: SecretVault,
  secretName: string,
  envKey?: string,
): string {
  try {
    const value = vault.get(secretName);
    if (value) return value;
  } catch {
    // Fall through to environment-backed secret lookup.
  }
  return envKey ? resolveEnvSecret(envKey) || "" : "";
}

function channelSecretValue(
  vault: SecretVault,
  raw: JsonRecord,
  channelName: string,
  field: string,
): string {
  const envKey = CHANNEL_SECRET_ENV_KEYS[channelName]?.[field];
  const secret = runtimeSecretValue(
    vault,
    channelSecretName(channelName, field),
    envKey,
  );
  if (secret) return secret;
  const settingsBlock = isRecord(raw.settings) ? raw.settings : {};
  const candidate = settingsBlock[field] ?? raw[field];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function configuredSecretsFromVault(
  vault: SecretVault,
  channelName: string,
): string[] {
  return configuredSecretFieldsFromVault(
    vault,
    channelName,
    CHANNEL_SECRET_FIELDS[channelName] || [],
  );
}

function configuredSecretFieldsFromVault(
  vault: SecretVault,
  channelName: string,
  fields: string[],
): string[] {
  return fields.filter((field) => {
    const envKey = CHANNEL_SECRET_ENV_KEYS[channelName]?.[field];
    return runtimeSecretConfigured(
      vault,
      channelSecretName(channelName, field),
      envKey,
    );
  });
}

function stripConfiguredSecretFields(
  raw: JsonRecord,
  channelName: string,
): JsonRecord {
  return stripSecretFields(raw, CHANNEL_SECRET_FIELDS[channelName] || []);
}

function stripSecretFields(raw: JsonRecord, fields: string[]): JsonRecord {
  const next = clone(raw);
  const settingsBlock = isRecord(next.settings) ? { ...next.settings } : {};
  for (const field of fields) {
    delete next[field];
    delete settingsBlock[field];
  }
  if (Object.keys(settingsBlock).length > 0) {
    next.settings = settingsBlock;
  } else {
    delete next.settings;
  }
  return next;
}

function configuredSecretFieldsFromRaw(
  raw: JsonRecord,
  fields: string[],
): string[] {
  const settingsBlock = isRecord(raw.settings) ? raw.settings : {};
  return fields.filter((field) => {
    const value = settingsBlock[field] ?? raw[field];
    return typeof value === "string" ? value.trim() !== "" : Boolean(value);
  });
}

function safePluginChannelName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "plugin_channel";
}

function metadataStringField(
  metadata: JsonRecord,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function metadataStringArrayField(
  metadata: JsonRecord,
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

function pluginChannelSecretFieldsFromRegistry(
  paths: RuntimePaths,
): Record<string, string[]> {
  const registryPath = path.join(paths.skillsDir, ".plugin-registry.json");
  if (!fs.existsSync(registryPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
      skills?: Array<{
        contracts?: {
          channels?: Array<{
            name?: unknown;
            metadata?: unknown;
          }>;
        };
      }>;
    };
    const fieldsByChannel: Record<string, Set<string>> = {};
    for (const skill of parsed.skills || []) {
      for (const contract of skill.contracts?.channels || []) {
        if (typeof contract.name !== "string") continue;
        const metadata = isRecord(contract.metadata) ? contract.metadata : {};
        const channelName = safePluginChannelName(
          metadataStringField(metadata, "config_key", "configKey") ||
            metadataStringField(metadata, "name") ||
            contract.name,
        );
        const secretFields = metadataStringArrayField(
          metadata,
          "secret_fields",
          "secretFields",
        );
        if (secretFields.length === 0) continue;
        fieldsByChannel[channelName] ??= new Set<string>();
        for (const field of secretFields) {
          fieldsByChannel[channelName].add(field);
        }
      }
    }
    return Object.fromEntries(
      Object.entries(fieldsByChannel).map(([channelName, fields]) => [
        channelName,
        Array.from(fields),
      ]),
    );
  } catch (err) {
    console.warn(
      `[Launcher] Failed to load plugin channel secret metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

function pluginChannelConfigKeysFromRegistry(paths: RuntimePaths): string[] {
  const registryPath = path.join(paths.skillsDir, ".plugin-registry.json");
  if (!fs.existsSync(registryPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
      skills?: Array<{
        contracts?: {
          channels?: Array<{
            name?: unknown;
            metadata?: unknown;
          }>;
        };
      }>;
    };
    const channelKeys = new Set<string>();
    for (const skill of parsed.skills || []) {
      for (const contract of skill.contracts?.channels || []) {
        if (typeof contract.name !== "string") continue;
        const metadata = isRecord(contract.metadata) ? contract.metadata : {};
        channelKeys.add(
          safePluginChannelName(
            metadataStringField(metadata, "config_key", "configKey") ||
              metadataStringField(metadata, "name") ||
              contract.name,
          ),
        );
      }
    }
    return Array.from(channelKeys);
  } catch (err) {
    console.warn(
      `[Launcher] Failed to load plugin channel validation metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

function parseChannelProbeMode(value: unknown): ChannelProbeMode | undefined {
  return value === "mock" || value === "sandbox" || value === "live"
    ? value
    : undefined;
}

async function runTelegramLiveProbe(
  raw: JsonRecord,
  flattened: JsonRecord,
  vault: SecretVault,
): Promise<ChannelRuntimeProbeCheck[]> {
  if (
    process.env["NODE_ENV"] === "test" &&
    process.env["Hiro_ALLOW_TEST_LIVE_PROBES"] !== "true"
  ) {
    return [
      {
        id: "telegram_live_skipped",
        status: "warn",
        message:
          "Telegram live probe skipped under NODE_ENV=test to avoid provider traffic.",
      },
    ];
  }

  const token = channelSecretValue(vault, raw, "telegram", "token");
  if (!token) {
    return [
      {
        id: "telegram_auth_token",
        status: "fail",
        message: "Telegram bot token is not configured.",
      },
    ];
  }

  const baseUrl =
    typeof flattened.base_url === "string" && flattened.base_url.trim()
      ? flattened.base_url.trim()
      : "https://api.telegram.org";
  let endpoint: string;
  try {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return [
        {
          id: "telegram_base_url",
          status: "fail",
          message: "Telegram API base URL must use http:// or https://.",
        },
      ];
    }
    endpoint = `${parsed.toString().replace(/\/$/, "")}/bot${token}/getMe`;
  } catch {
    return [
      {
        id: "telegram_base_url",
        status: "fail",
        message: "Telegram API base URL is invalid.",
      },
    ];
  }

  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const payload = isRecord(body) ? body : {};
    const result = isRecord(payload.result) ? payload.result : {};
    if (response.status === 429) {
      return [
        {
          id: "telegram_rate_limited",
          status: "fail",
          message: "Telegram API rate limited the live probe.",
        },
      ];
    }
    if (response.status === 401 || response.status === 403) {
      return [
        {
          id: "telegram_auth",
          status: "fail",
          message: "Telegram rejected the saved bot token.",
        },
      ];
    }
    if (!response.ok || payload.ok !== true || result.is_bot !== true) {
      return [
        {
          id: "telegram_auth",
          status: "fail",
          message: `Telegram live probe failed with HTTP ${response.status}.`,
        },
      ];
    }
    const username =
      typeof result.username === "string" && result.username.trim()
        ? ` as @${result.username.trim()}`
        : "";
    return [
      {
        id: "telegram_get_me",
        status: "pass",
        message: `Telegram bot identity verified${username}.`,
      },
    ];
  } catch (error) {
    return [
      {
        id: "telegram_runtime",
        status: "fail",
        message: `Telegram live probe failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      },
    ];
  }
}

function extractChannelSecretsToVault(
  config: JsonRecord,
  vault: SecretVault,
  paths: RuntimePaths,
): JsonRecord {
  const next = clone(config);
  const channels = isRecord(next.channels) ? { ...next.channels } : {};
  for (const [channelName, fields] of Object.entries(CHANNEL_SECRET_FIELDS)) {
    const raw = isRecord(channels[channelName])
      ? { ...(channels[channelName] as JsonRecord) }
      : undefined;
    if (!raw) continue;
    const settingsBlock = isRecord(raw.settings) ? { ...raw.settings } : {};
    for (const field of fields) {
      const candidate = settingsBlock[field] ?? raw[field];
      if (
        typeof candidate === "string" &&
        candidate.trim() &&
        !isMaskedSecret(candidate)
      ) {
        const envKey = CHANNEL_SECRET_ENV_KEYS[channelName]?.[field];
        setRuntimeSecret(
          vault,
          paths.configDir,
          channelSecretName(channelName, field),
          candidate.trim(),
          envKey,
        );
      }
      delete settingsBlock[field];
      delete raw[field];
    }
    if (Object.keys(settingsBlock).length > 0) {
      raw.settings = settingsBlock;
    } else {
      delete raw.settings;
    }
    channels[channelName] = raw;
  }
  for (const [channelName, fields] of Object.entries(
    pluginChannelSecretFieldsFromRegistry(paths),
  )) {
    if (CHANNEL_SECRET_FIELDS[channelName]) continue;
    const raw = isRecord(channels[channelName])
      ? { ...(channels[channelName] as JsonRecord) }
      : undefined;
    if (!raw) continue;
    const settingsBlock = isRecord(raw.settings) ? { ...raw.settings } : {};
    for (const field of fields) {
      const candidate = settingsBlock[field] ?? raw[field];
      if (
        typeof candidate === "string" &&
        candidate.trim() &&
        !isMaskedSecret(candidate)
      ) {
        setRuntimeSecret(
          vault,
          paths.configDir,
          channelSecretName(channelName, field),
          candidate.trim(),
        );
      }
      delete settingsBlock[field];
      delete raw[field];
    }
    if (Object.keys(settingsBlock).length > 0) {
      raw.settings = settingsBlock;
    } else {
      delete raw.settings;
    }
    channels[channelName] = raw;
  }
  next.channels = channels;
  return next;
}

function extractWebSearchSecretsToVault(
  config: JsonRecord,
  vault: SecretVault,
): JsonRecord {
  const next = clone(config);
  const webSearch = isRecord(next.web_search) ? { ...next.web_search } : {};
  const settingsBlock = isRecord(webSearch.settings)
    ? { ...webSearch.settings }
    : {};
  for (const [providerId, rawSettings] of Object.entries(settingsBlock)) {
    if (!isRecord(rawSettings)) continue;
    const providerSettings = { ...rawSettings };
    const apiKey = providerSettings.api_key;
    if (
      typeof apiKey === "string" &&
      apiKey.trim() &&
      !isMaskedSecret(apiKey)
    ) {
      vault.set(`web_search/${providerId}/api_key`, apiKey.trim());
      providerSettings.api_key_set = true;
    }
    delete providerSettings.api_key;
    settingsBlock[providerId] = providerSettings;
  }
  if (Object.keys(settingsBlock).length > 0) {
    webSearch.settings = settingsBlock;
    next.web_search = webSearch;
  }
  return next;
}

function extractMcpHeaderSecretsToVault(
  config: JsonRecord,
  vault: SecretVault,
): JsonRecord {
  const next = clone(config);
  const tools = isRecord(next.tools) ? { ...next.tools } : {};
  const mcp = isRecord(tools.mcp) ? { ...tools.mcp } : {};
  const servers = isRecord(mcp.servers) ? { ...mcp.servers } : {};
  for (const [serverName, rawServer] of Object.entries(servers)) {
    if (!isRecord(rawServer)) continue;
    const server = { ...rawServer };
    const headers = isRecord(server.headers) ? { ...server.headers } : {};
    for (const [headerName, headerValue] of Object.entries(headers)) {
      if (
        typeof headerValue === "string" &&
        headerValue.trim() &&
        SECRET_REF_FIELD_PATTERN.test(headerName)
      ) {
        const secretName = `mcp/${serverName}/headers/${headerName}`;
        vault.set(secretName, headerValue.trim());
        headers[headerName] = { secret_ref: secretName };
      } else if (isSecretRef(headerValue)) {
        headers[headerName] = { secret_ref: headerValue.secret_ref };
      }
    }
    server.headers = headers;
    servers[serverName] = server;
  }
  mcp.servers = servers;
  tools.mcp = mcp;
  next.tools = tools;
  return next;
}

function extractRuntimeSecretsToVault(
  config: JsonRecord,
  vault: SecretVault,
  paths: RuntimePaths,
): JsonRecord {
  return extractMcpHeaderSecretsToVault(
    extractWebSearchSecretsToVault(
      extractChannelSecretsToVault(config, vault, paths),
      vault,
    ),
    vault,
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readYamlFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return (yaml.load(fs.readFileSync(filePath, "utf-8")) || fallback) as T;
  } catch {
    return fallback;
  }
}

function writeYamlFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(
    filePath,
    yaml.dump(value, { lineWidth: 100, noRefs: true, sortKeys: false }),
    "utf-8",
  );
}

function recordOrEmpty(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function boolOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function qrBindingFlowID(channel: QrBindingChannel): string {
  const prefix = channel === "weixin" ? "wx" : "wc";
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function isTerminalQrStatus(status: QrBindingStatus): boolean {
  return status === "confirmed" || status === "expired" || status === "error";
}

function normalizeQrBindingStatus(value: unknown): QrBindingStatus {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  switch (normalized) {
    case "wait":
      return "wait";
    case "scaned":
    case "scanned":
    case "scaned_but_redirect":
      return "scaned";
    case "confirmed":
    case "success":
      return "confirmed";
    case "expired":
      return "expired";
    case "error":
      return "error";
    default:
      return "wait";
  }
}

function qrBindingFlowResponse(flow: QrBindingFlow): QrBindingFlowResponse {
  const response: QrBindingFlowResponse = {
    flow_id: flow.id,
    status: flow.status,
  };
  if (flow.status === "wait" || flow.status === "scaned") {
    response.qr_data_uri = flow.qrDataURI;
  }
  if (flow.accountId) response.account_id = flow.accountId;
  if (flow.botId) response.bot_id = flow.botId;
  if (flow.error) response.error = flow.error;
  return response;
}

async function generateQrDataURI(content: string): Promise<string> {
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: "L",
    margin: 2,
    width: 240,
  });
}

async function fetchJson<T>(targetURL: string, timeoutMs: number): Promise<T> {
  const response = await fetch(targetURL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `Provider returned non-JSON response: ${text.slice(0, 256)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Provider HTTP ${response.status}: ${redactSecrets(text.slice(0, 512))}`,
    );
  }
  return body as T;
}

function urlWithQuery(
  rawURL: string,
  query: Record<string, string | number>,
): string {
  const parsed = new URL(rawURL);
  for (const [key, value] of Object.entries(query)) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

function weixinApiURL(
  baseURL: string,
  pathName: string,
  query: Record<string, string>,
): string {
  const parsed = new URL(
    pathName,
    baseURL.endsWith("/") ? baseURL : `${baseURL}/`,
  );
  for (const [key, value] of Object.entries(query)) {
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

function wecomPlatformCode(): number {
  switch (process.platform) {
    case "darwin":
      return 1;
    case "win32":
      return 2;
    case "linux":
      return 3;
    default:
      return 0;
  }
}

function isDisabledLevel(level: unknown): boolean {
  return ["DISABLED", "OFF", "DENY", "DENIED", "BLOCKED"].includes(
    String(level || "").toUpperCase(),
  );
}

function runtimeConfigFromFiles(paths: RuntimePaths): JsonRecord {
  const agentYaml = readYamlFile<JsonRecord>(
    path.join(paths.configDir, "agent.yaml"),
    {},
  );
  const toolsYaml = readYamlFile<JsonRecord>(
    path.join(paths.configDir, "tools.yaml"),
    {},
  );
  const agent = recordOrEmpty(agentYaml.agent);
  const agentHeartbeat = recordOrEmpty(agent.heartbeat);
  const rootHeartbeat = recordOrEmpty(agentYaml.heartbeat);
  const heartbeatSource = Object.keys(rootHeartbeat).length
    ? rootHeartbeat
    : agentHeartbeat;
  const agents = recordOrEmpty(agentYaml.agents);
  const defaults = {
    ...recordOrEmpty(agents.defaults),
    workspace:
      String(recordOrEmpty(agents.defaults).workspace || "").trim() ||
      (paths.sourceDir ?? paths.configDir),
  } as JsonRecord;

  const maxTokens = numberOrUndefined(
    agent.max_tokens_per_cycle ?? defaults.max_tokens,
  );
  if (maxTokens != null) defaults.max_tokens = maxTokens;

  const heartbeat = { ...heartbeatSource } as JsonRecord;
  const heartbeatInterval = numberOrUndefined(
    heartbeat.interval ?? heartbeat.interval_seconds,
  );
  if (boolOrUndefined(heartbeat.enabled) != null) {
    heartbeat.enabled = boolOrUndefined(heartbeat.enabled);
  }
  if (heartbeatInterval != null) heartbeat.interval = heartbeatInterval;
  delete heartbeat.interval_seconds;

  const runtimeTools = recordOrEmpty(toolsYaml.runtime);
  const permissions = recordOrEmpty(toolsYaml.permissions);
  const shellPermission = recordOrEmpty(permissions.shell_execute);
  const execConfig = { ...recordOrEmpty(runtimeTools.exec) } as JsonRecord;
  if (boolOrUndefined(execConfig.enabled) == null) {
    execConfig.enabled = !isDisabledLevel(shellPermission.level);
  }
  const timeout = numberOrUndefined(
    execConfig.timeout_seconds ?? shellPermission.max_timeout_seconds,
  );
  if (timeout != null) execConfig.timeout_seconds = timeout;

  const channels = mergeChannelSetupDefaults(
    Object.keys(recordOrEmpty(agentYaml.channels)).length > 0
      ? recordOrEmpty(agentYaml.channels)
      : recordOrEmpty(agentYaml.channel_list),
  );

  const runtime: JsonRecord = {
    agents: mergePatch(agents, { defaults }),
    heartbeat,
    session: recordOrEmpty(agentYaml.session),
    evolution: recordOrEmpty(agentYaml.evolution),
    devices: recordOrEmpty(agentYaml.devices),
    tools: mergePatch(runtimeTools, { exec: execConfig }),
    channels,
    channel_list: channels,
  };

  if (isRecord(toolsYaml.web_search)) runtime.web_search = toolsYaml.web_search;
  return runtime;
}

function syncAgentYaml(paths: RuntimePaths, config: JsonRecord): void {
  const configPath = path.join(paths.configDir, "agent.yaml");
  const existing = readYamlFile<JsonRecord>(configPath, {});
  const next = clone(existing);
  const agent = { ...recordOrEmpty(next.agent) } as JsonRecord;
  const configAgent = recordOrEmpty(config.agent);
  const agents = recordOrEmpty(config.agents);
  const defaults = recordOrEmpty(agents.defaults);

  delete agent.heartbeat;
  delete agent.self_improvement;
  delete agent.skill_governance;

  const maxTokens = numberOrUndefined(defaults.max_tokens);
  if (maxTokens != null) agent.max_tokens_per_cycle = maxTokens;
  if (isRecord(configAgent.security)) {
    agent.security = {
      ...recordOrEmpty(agent.security),
      ...recordOrEmpty(configAgent.security),
    };
  }
  next.agent = agent;
  next.agents = agents;
  next.session = recordOrEmpty(config.session);
  next.evolution = recordOrEmpty(config.evolution);
  next.devices = recordOrEmpty(config.devices);

  const channels = recordOrEmpty(config.channels);
  next.channels = channels;
  next.channel_list = channels;

  const existingHeartbeat = recordOrEmpty(next.heartbeat);
  const heartbeat = recordOrEmpty(config.heartbeat);
  const intervalSeconds = numberOrUndefined(
    heartbeat.interval ?? heartbeat.interval_seconds,
  );
  next.heartbeat = {
    ...existingHeartbeat,
    ...heartbeat,
    ...(intervalSeconds != null ? { interval_seconds: intervalSeconds } : {}),
  };
  delete recordOrEmpty(next.heartbeat).interval;

  if (!isRecord(next.self_improvement) && isRecord(existing.agent)) {
    const nested = recordOrEmpty(existing.agent).self_improvement;
    if (isRecord(nested)) next.self_improvement = nested;
  }
  if (!isRecord(next.skill_governance) && isRecord(existing.agent)) {
    const nested = recordOrEmpty(existing.agent).skill_governance;
    if (isRecord(nested)) next.skill_governance = nested;
  }

  writeYamlFile(configPath, next);
}

function syncToolsYaml(
  paths: RuntimePaths,
  config: JsonRecord,
  state: CompatState,
): void {
  const configPath = path.join(paths.configDir, "tools.yaml");
  const existing = readYamlFile<JsonRecord>(configPath, {});
  const next = clone(existing);
  const permissions = { ...recordOrEmpty(next.permissions) } as JsonRecord;
  const uiTools = recordOrEmpty(config.tools);
  const execConfig = recordOrEmpty(uiTools.exec);
  const shellPermission = {
    ...recordOrEmpty(permissions.shell_execute),
  } as JsonRecord;

  const toolState = { ...(state.tool_state || {}) };
  // Preserve existing disabled_tools from tools.yaml that aren't in launcher state
  const existingDisabledTools = Array.isArray(next.disabled_tools)
    ? (next.disabled_tools as string[])
    : [];
  for (const name of existingDisabledTools) {
    if (toolState[name] === undefined) {
      toolState[name] = false;
    }
  }
  const execEnabled = boolOrUndefined(execConfig.enabled);
  const shellEnabled = toolState.shell_execute ?? execEnabled;
  if (shellEnabled != null)
    shellPermission.level = shellEnabled ? "TRUSTED_FULL_ACCESS" : "DISABLED";
  const timeout = numberOrUndefined(execConfig.timeout_seconds);
  if (timeout != null && timeout > 0)
    shellPermission.max_timeout_seconds = timeout;
  shellPermission.workspace_only = false;
  permissions.shell_execute = shellPermission;

  for (const name of ["file_read", "file_write", "file_delete"]) {
    const filePermission = {
      ...recordOrEmpty(permissions[name]),
    } as JsonRecord;
    if (!isDisabledLevel(filePermission.level)) {
      filePermission.level = "TRUSTED_FULL_ACCESS";
    }
    filePermission.workspace_only = false;
    filePermission.allow_absolute_paths = true;
    permissions[name] = filePermission;
  }

  next.permissions = permissions;

  if (execEnabled != null && toolState.shell_execute == null) {
    toolState.shell_execute = execEnabled;
  }
  next.tool_state = toolState;
  next.disabled_tools = Object.entries(toolState)
    .filter(([, enabled]) => enabled === false)
    .map(([name]) => name);
  next.runtime = {
    ...recordOrEmpty(next.runtime),
    cron: recordOrEmpty(uiTools.cron),
    exec: execConfig,
    mcp: recordOrEmpty(uiTools.mcp),
  };
  next.web_search = state.web_search || WEB_SEARCH_DEFAULT;

  writeYamlFile(configPath, next);
}

function fileManagerAllowsSystemWrite(_config: unknown): boolean {
  return true;
}

function defaultAppConfig(paths: RuntimePaths): JsonRecord {
  const channels = defaultChannelSetupConfig();
  return {
    agent: {
      security: {
        bypass_restrictions: true,
        system_access: "full",
      },
    },
    agents: {
      defaults: {
        workspace: paths.sourceDir ?? paths.configDir,
        restrict_to_workspace: false,
        split_on_marker: false,
        max_tokens: settings.defaultMaxTokens || 4096,
        context_window: 0,
        max_tool_iterations: 50,
        summarize_message_threshold: 20,
        summarize_token_percent: 75,
        tool_feedback: {
          enabled: true,
          max_args_length: 300,
          separate_messages: false,
        },
        turn_profile: {
          enabled: false,
          history: { mode: "default" },
          system_prompt: { mode: "default" },
          skills: { mode: "default" },
          tools: { mode: "default" },
        },
      },
    },
    session: {
      dm_scope: "per-channel-peer",
    },
    heartbeat: {
      enabled: true,
      interval: 30,
    },
    devices: {
      enabled: false,
      monitor_usb: true,
    },
    evolution: {
      enabled: false,
      mode: "observe",
      state_dir: "",
      min_task_count: 2,
      min_success_ratio: 0.7,
      cold_path_trigger: "after_turn",
      cold_path_times: [],
    },
    tools: {
      cron: {
        allow_command: false,
        exec_timeout_minutes: 5,
      },
      exec: {
        enabled: true,
        allow_remote: false,
        enable_deny_patterns: false,
        custom_allow_patterns: [],
        custom_deny_patterns: [],
        timeout_seconds: 0,
      },
      mcp: {
        enabled: true,
        discovery: {
          enabled: true,
          ttl: 5,
          max_search_results: 5,
          use_bm25: true,
          use_regex: false,
        },
        servers: {},
      },
    },
    channels,
    channel_list: channels,
  };
}

function defaultChannelSetupConfig(): JsonRecord {
  const channels: JsonRecord = {};
  for (const channel of SUPPORTED_CHANNELS) {
    channels[channel.config_key] ??= {
      enabled: true,
      type: channel.config_key,
    };
  }
  return channels;
}

function mergeChannelSetupDefaults(channels: JsonRecord): JsonRecord {
  return mergePatch(defaultChannelSetupConfig(), channels);
}

function mergePatch(target: JsonRecord, patch: JsonRecord): JsonRecord {
  const next = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
      continue;
    }
    if (isRecord(value) && isRecord(next[key])) {
      next[key] = mergePatch(next[key] as JsonRecord, value);
      continue;
    }
    next[key] = value;
  }
  return next;
}

function stripChannelAliases(config: JsonRecord): JsonRecord {
  const next = clone(config);
  if (isRecord(next.channels)) {
    next.channel_list = next.channels;
  } else if (isRecord(next.channel_list)) {
    next.channels = next.channel_list;
  } else {
    next.channels = {};
    next.channel_list = next.channels;
  }
  return next;
}

class ConfigValidationError extends Error {
  constructor(public readonly validation: ConfigValidationResult) {
    super("Invalid runtime config");
    this.name = "ConfigValidationError";
  }
}

function configValidationMessages(
  validation: ConfigValidationResult,
): string[] {
  return validation.errors.map((item) => `${item.path}: ${item.message}`);
}

function configValidationSummary(validation: ConfigValidationResult) {
  return {
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
  };
}

function validateAndNormalizeConfig(
  config: JsonRecord,
  options: { allowedChannelNames?: string[] } = {},
): {
  config: JsonRecord;
  validation: ConfigValidationResult;
} {
  const validation = validateRuntimeConfig(stripChannelAliases(config), {
    allowedChannelNames: options.allowedChannelNames,
  });
  if (!validation.valid) {
    throw new ConfigValidationError(validation);
  }
  return {
    config: stripChannelAliases(validation.config as JsonRecord),
    validation,
  };
}

function sendConfigValidationError(res: Response, err: unknown): void {
  if (err instanceof ConfigValidationError) {
    res.status(400).json({
      error: "Invalid runtime config",
      errors: configValidationMessages(err.validation),
      validation: configValidationSummary(err.validation),
    });
    return;
  }
  res.status(500).json({
    error: err instanceof Error ? err.message : String(err),
  });
}

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function readCookieHeader(
  cookieHeader: string | string[] | undefined,
  name: string,
): string {
  const raw = firstHeaderValue(cookieHeader);
  for (const part of raw.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return "";
}

function readCookie(req: Request, name: string): string {
  return readCookieHeader(req.headers.cookie, name);
}

function setSessionCookie(res: Response, token: string): void {
  const secure = process.env["NODE_ENV"] === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}${secure}`,
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(password: string, auth?: StoredAuth): boolean {
  if (!auth?.salt || !auth.password_hash) return false;
  const incoming = Buffer.from(hashPassword(password, auth.salt), "hex");
  const stored = Buffer.from(auth.password_hash, "hex");
  return (
    incoming.length === stored.length &&
    crypto.timingSafeEqual(incoming, stored)
  );
}

function isSessionTokenAuthenticated(token: string): boolean {
  if (!token) return false;
  const expiresAt = activeSessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

function isAuthenticatedCookieHeader(
  cookieHeader: string | string[] | undefined,
): boolean {
  return isSessionTokenAuthenticated(
    readCookieHeader(cookieHeader, AUTH_COOKIE),
  );
}

function isAuthenticated(req: Request): boolean {
  return isAuthenticatedCookieHeader(req.headers.cookie);
}

function loginFailureKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function isLoginLimited(req: Request): boolean {
  const key = loginFailureKey(req);
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (entry.resetAt < Date.now()) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILED_LOGINS;
}

function noteLoginFailure(req: Request): void {
  const key = loginFailureKey(req);
  const existing = loginFailures.get(key);
  if (!existing || existing.resetAt < Date.now()) {
    loginFailures.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    return;
  }
  existing.count += 1;
}

function updateEnvVar(paths: RuntimePaths, key: string, value: string): void {
  const envPath = path.join(paths.configDir, ".env");
  let content = "";
  try {
    content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  } catch {
    content = "";
  }

  const line = `${key}=${value}`;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped}=.*$`, "m");
  if (isSecretEnvKey(key)) {
    setEnvSecret(key, value, paths.configDir);
    if (regex.test(content)) {
      const next = content.replace(regex, "").replace(/\n{3,}/g, "\n\n");
      fs.writeFileSync(envPath, next.trimStart(), "utf-8");
    }
    return;
  }
  if (regex.test(content)) {
    content =
      value === ""
        ? content.replace(regex, "").replace(/\n{3,}/g, "\n\n")
        : content.replace(regex, line);
  } else if (value !== "") {
    content = `${content.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(envPath, content.trimStart(), "utf-8");
  process.env[key] = value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function changedChannelNames(
  beforeConfig: JsonRecord | undefined,
  afterConfig: JsonRecord | undefined,
): string[] {
  const before = recordOrEmpty(beforeConfig?.channels);
  const after = recordOrEmpty(afterConfig?.channels);
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(names).filter(
    (name) => stableJson(before[name]) !== stableJson(after[name]),
  );
}

const LITELLM_RESTART_TIMEOUT_MS = 1_500;

function gatewayHostForPublic(publicMode: boolean): string {
  return publicMode ? "0.0.0.0" : "127.0.0.1";
}

async function restartLiteLLMThroughGateway(port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/gateway/litellm/restart`;
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(LITELLM_RESTART_TIMEOUT_MS),
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    throw new Error(
      detail.trim() || `LiteLLM reload failed with HTTP ${response.status}`,
    );
  }
}

const WINDOWS_RUN_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_RUN_VALUE = "Hiro";
const MACOS_LAUNCH_AGENT_ID = "io.Hiro.launcher";
const LINUX_DESKTOP_FILE = "Hiro.desktop";

function autostartCommand(paths: RuntimePaths): string {
  return `"${process.execPath}" "${path.join(paths.binDir, "Hiro.js")}"`;
}

function autostartSupported(): boolean {
  return ["win32", "darwin", "linux"].includes(process.platform);
}

function windowsAutostartEnabled(): boolean {
  if (process.platform !== "win32") return false;
  const result = child_process.spawnSync(
    "reg.exe",
    ["query", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE],
    { encoding: "utf-8", shell: false },
  );
  return result.status === 0;
}

function setWindowsAutostart(paths: RuntimePaths, enabled: boolean): void {
  if (process.platform !== "win32") {
    throw new Error(
      "Launch-at-login is only implemented on Windows in this build.",
    );
  }
  const args = enabled
    ? [
        "add",
        WINDOWS_RUN_KEY,
        "/v",
        WINDOWS_RUN_VALUE,
        "/t",
        "REG_SZ",
        "/d",
        autostartCommand(paths),
        "/f",
      ]
    : ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"];
  const result = child_process.spawnSync("reg.exe", args, {
    encoding: "utf-8",
    shell: false,
  });
  if (result.status !== 0 && enabled) {
    throw new Error(
      String(
        result.stderr ||
          result.stdout ||
          "Failed to update Windows Run registry.",
      ),
    );
  }
  if (
    result.status !== 0 &&
    !String(result.stderr || result.stdout || "").includes("unable to find")
  ) {
    throw new Error(
      String(
        result.stderr ||
          result.stdout ||
          "Failed to update Windows Run registry.",
      ),
    );
  }
}

function macosAutostartPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${MACOS_LAUNCH_AGENT_ID}.plist`,
  );
}

function linuxAutostartPath(): string {
  const configHome =
    process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
  return path.join(configHome, "autostart", LINUX_DESKTOP_FILE);
}

function quoteDesktopExecArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function macosAutostartEnabled(): boolean {
  return fs.existsSync(macosAutostartPath());
}

function linuxAutostartEnabled(): boolean {
  return fs.existsSync(linuxAutostartPath());
}

function setMacosAutostart(paths: RuntimePaths, enabled: boolean): void {
  const plistPath = macosAutostartPath();
  if (!enabled) {
    fs.rmSync(plistPath, { force: true });
    return;
  }

  ensureDir(path.dirname(plistPath));
  const scriptPath = path.join(paths.binDir, "Hiro.js");
  const wd = paths.sourceDir ?? paths.configDir;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_LAUNCH_AGENT_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(scriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(wd)}</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist, "utf-8");
}

function setLinuxAutostart(paths: RuntimePaths, enabled: boolean): void {
  const desktopPath = linuxAutostartPath();
  if (!enabled) {
    fs.rmSync(desktopPath, { force: true });
    return;
  }

  ensureDir(path.dirname(desktopPath));
  const scriptPath = path.join(paths.binDir, "Hiro.js");
  const wd = paths.sourceDir ?? paths.configDir;
  const desktop = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Hiro",
    `Exec=${quoteDesktopExecArg(process.execPath)} ${quoteDesktopExecArg(scriptPath)}`,
    `Path=${wd}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
  fs.writeFileSync(desktopPath, desktop, "utf-8");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function platformAutostartEnabled(): boolean {
  switch (process.platform) {
    case "win32":
      return windowsAutostartEnabled();
    case "darwin":
      return macosAutostartEnabled();
    case "linux":
      return linuxAutostartEnabled();
    default:
      return false;
  }
}

function setPlatformAutostart(paths: RuntimePaths, enabled: boolean): void {
  switch (process.platform) {
    case "win32":
      setWindowsAutostart(paths, enabled);
      return;
    case "darwin":
      setMacosAutostart(paths, enabled);
      return;
    case "linux":
      setLinuxAutostart(paths, enabled);
      return;
    default:
      throw new Error(
        `Launch-at-login is not supported on ${process.platform}.`,
      );
  }
}

function apiKeyEnvForProvider(provider: string): string {
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
    case "elevenlabs":
      return "ELEVENLABS_API_KEY";
    default:
      return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  }
}

function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isMaskedSecret(value: unknown): boolean {
  return typeof value === "string" && /^(\*+|.+\.\.\..+)$/.test(value);
}

function getProviderOption(provider: string) {
  return (
    PROVIDER_OPTIONS.find(
      (item) =>
        item.id === provider ||
        item.aliases?.includes(provider) ||
        (provider === "gemini" && item.id === "google"),
    ) || PROVIDER_OPTIONS[3]
  );
}

async function launcherProviderOptions(
  paths: RuntimePaths,
): Promise<ProviderOption[]> {
  const builtIns = PROVIDER_OPTIONS.map((option) => ({
    ...option,
    source: option.source || ("builtin" as const),
  }));
  const seen = new Set(builtIns.map((option) => option.id));
  const pluginOptions = (
    await listRuntimePluginProviderMetadata(paths.sourceDir ?? paths.configDir)
  )
    .filter((provider) => !seen.has(provider.id))
    .map((provider): ProviderOption => {
      seen.add(provider.id);
      return {
        id: provider.id,
        display_name: provider.displayName,
        icon_slug: "plugin",
        default_api_base: provider.baseUrl,
        empty_api_key_allowed:
          provider.authMethod === "none" || provider.local === true,
        create_allowed: true,
        default_model_allowed: true,
        supports_fetch: provider.supportsFetch,
        default_auth_method: provider.authMethod,
        local: provider.local,
        priority: 10,
        common_models: provider.models,
        source: "plugin",
      };
    });
  return [...builtIns, ...pluginOptions];
}

function normalizeProvider(
  provider: string | undefined,
  modelName = "",
): string {
  const raw = (provider || "").trim().toLowerCase();
  if (raw === "gemini") return "google";
  if (raw && getProviderOption(raw).id === raw) return raw;
  const name = modelName.toLowerCase();
  if (name.startsWith("openai/") || name.startsWith("gpt-")) return "openai";
  if (name.startsWith("anthropic/") || name.startsWith("claude"))
    return "anthropic";
  if (name.startsWith("google/") || name.startsWith("gemini")) return "google";
  if (name.startsWith("deepseek")) return "deepseek";
  if (name.startsWith("ollama/")) return "ollama";
  const slash = name.indexOf("/");
  if (slash > 0) {
    const prefix = name.slice(0, slash);
    const option = PROVIDER_OPTIONS.find(
      (item) => item.id === prefix || item.aliases?.includes(prefix),
    );
    return option?.id || "openrouter";
  }
  return settings.provider === "google"
    ? "google"
    : settings.provider || "openrouter";
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

function validateModelIdentifier(modelName: string): void {
  if (!modelName.trim()) {
    throw new Error("model_name is required");
  }
  if (/\s/.test(modelName)) {
    throw new Error("model_name must not contain whitespace");
  }
  if (modelName.startsWith("/")) {
    throw new Error("model_name must not start with /");
  }
  if (modelName.includes("//")) {
    throw new Error("model_name must not contain consecutive / characters");
  }
  const slash = modelName.indexOf("/");
  if (slash >= 0 && slash === modelName.length - 1) {
    throw new Error("model_name must include a model id after the provider");
  }
}

function normalizeSecretInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveProviderApiKey(
  provider: string,
  paths: RuntimePaths,
  explicit?: unknown,
): string {
  return (
    normalizeSecretInput(explicit) ||
    normalizeSecretInput(
      resolveEnvSecret(apiKeyEnvForProvider(provider), paths.configDir),
    )
  );
}

function validateProviderApiBase(apiBase: string): void {
  if (!apiBase.trim()) return;
  let parsed: URL;
  try {
    parsed = new URL(apiBase.trim());
  } catch {
    throw new Error("api_base must be a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("api_base must use http:// or https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("api_base must not include credentials");
  }
}

function defaultModelsFromSettings(): StoredModel[] {
  const names = Array.from(new Set(settings.getSupportedModels()));
  if (!names.includes(settings.defaultModel)) {
    names.unshift(settings.defaultModel);
  }
  return names.map((modelName) => {
    const provider = normalizeProvider(undefined, modelName);
    return {
      model_name: modelName,
      provider,
      model: modelBodyName(modelName, provider),
      api_base: getProviderOption(provider).default_api_base,
      enabled: true,
    };
  });
}

function modelInfoFromStored(
  stored: StoredModel,
  index: number,
  configDir?: string,
) {
  const provider = normalizeProvider(stored.provider, stored.model_name);
  const option = getProviderOption(provider);
  const apiKey = resolveEnvSecret(apiKeyEnvForProvider(provider), configDir);
  const available = Boolean(option.empty_api_key_allowed || apiKey);
  const modelName = stored.model_name;
  return {
    index,
    model_name: modelName,
    provider,
    model: stored.model || modelBodyName(modelName, provider),
    api_base: stored.api_base ?? option.default_api_base,
    api_key: maskSecret(apiKey),
    api_key_set: Boolean(apiKey),
    proxy: stored.proxy,
    auth_method: stored.auth_method ?? option.default_auth_method,
    connect_mode: stored.connect_mode,
    workspace: stored.workspace,
    rpm: stored.rpm,
    max_tokens_field: stored.max_tokens_field,
    request_timeout: stored.request_timeout,
    thinking_level: stored.thinking_level,
    tool_schema_transform: stored.tool_schema_transform,
    streaming: stored.streaming,
    extra_body: stored.extra_body,
    custom_headers: stored.custom_headers
      ? redactSecrets(stored.custom_headers)
      : undefined,
    enabled: stored.enabled !== false,
    available,
    status: available ? "available" : "unconfigured",
    is_default: modelName === settings.defaultModel,
    is_virtual: false,
    default_model_allowed: option.default_model_allowed,
  };
}

function normalizeStoredModel(stored: StoredModel): StoredModel {
  const provider = normalizeProvider(stored.provider, stored.model_name);
  const inferredProvider = normalizeProvider(undefined, stored.model_name);
  const slash = stored.model_name.indexOf("/");
  const providerMismatch =
    slash > 0 &&
    inferredProvider === "openrouter" &&
    !stored.model_name.toLowerCase().startsWith(`${provider}/`);
  const normalizedProvider = providerMismatch ? inferredProvider : provider;
  const option = getProviderOption(normalizedProvider);
  return {
    ...stored,
    provider: normalizedProvider,
    model: modelBodyName(stored.model_name, normalizedProvider),
    api_base: providerMismatch
      ? option.default_api_base
      : (stored.api_base ?? option.default_api_base),
  };
}

function normalizeIncomingModel(
  input: JsonRecord,
  existing?: StoredModel,
): StoredModel {
  const modelName = String(
    input.model_name || input.model || existing?.model_name || "",
  ).trim();
  if (!modelName) {
    throw new Error("model_name is required");
  }
  validateModelIdentifier(modelName);
  const provider = normalizeProvider(
    typeof input.provider === "string" ? input.provider : existing?.provider,
    modelName,
  );
  const option = getProviderOption(provider);
  return {
    ...existing,
    model_name: modelName,
    provider,
    model:
      typeof input.model === "string" && input.model.trim()
        ? input.model.trim()
        : existing?.model || modelBodyName(modelName, provider),
    api_base:
      typeof input.api_base === "string"
        ? input.api_base.trim()
        : existing?.api_base || option.default_api_base,
    proxy:
      typeof input.proxy === "string" ? input.proxy.trim() : existing?.proxy,
    auth_method:
      typeof input.auth_method === "string"
        ? input.auth_method.trim()
        : existing?.auth_method || option.default_auth_method,
    enabled:
      typeof input.enabled === "boolean"
        ? input.enabled
        : (existing?.enabled ?? true),
    connect_mode:
      typeof input.connect_mode === "string"
        ? input.connect_mode
        : existing?.connect_mode,
    workspace:
      typeof input.workspace === "string"
        ? input.workspace
        : existing?.workspace,
    rpm: typeof input.rpm === "number" ? input.rpm : existing?.rpm,
    max_tokens_field:
      typeof input.max_tokens_field === "string"
        ? input.max_tokens_field
        : existing?.max_tokens_field,
    request_timeout:
      typeof input.request_timeout === "number"
        ? input.request_timeout
        : existing?.request_timeout,
    thinking_level:
      typeof input.thinking_level === "string"
        ? input.thinking_level
        : existing?.thinking_level,
    tool_schema_transform:
      typeof input.tool_schema_transform === "string"
        ? input.tool_schema_transform
        : existing?.tool_schema_transform,
    streaming: isRecord(input.streaming)
      ? (input.streaming as { enabled?: boolean })
      : existing?.streaming,
    extra_body: isRecord(input.extra_body)
      ? input.extra_body
      : existing?.extra_body,
    custom_headers: isRecord(input.custom_headers)
      ? Object.fromEntries(
          Object.entries(input.custom_headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : existing?.custom_headers,
  };
}

function saveSupportedModels(paths: RuntimePaths, models: StoredModel[]): void {
  const modelNames = models.map((model) => model.model_name).filter(Boolean);
  updateEnvVar(
    paths,
    "SUPPORTED_MODELS",
    Array.from(new Set(modelNames)).join(","),
  );
}

function updateLiteLLMEnv(paths: RuntimePaths): void {
  updateEnvVar(paths, "LITELLM_BASE_URL", litellmBaseUrlFromEnv());
  const configuredPath = process.env["LITELLM_CONFIG_PATH"];
  if (!configuredPath) {
    updateEnvVar(paths, "LITELLM_CONFIG_PATH", "config/litellm.yaml");
  }
}

function hasLiteLLMCredentials(
  paths: RuntimePaths,
  model: StoredModel,
): boolean {
  if (model.enabled === false || !model.model_name) return false;
  const provider = normalizeProvider(model.provider, model.model_name);
  const option = getProviderOption(provider);
  if (option.empty_api_key_allowed) return true;
  return Boolean(
    resolveEnvSecret(apiKeyEnvForProvider(provider), paths.configDir),
  );
}

function syncLiteLLMRuntimeConfig(paths: RuntimePaths, models: StoredModel[]) {
  updateLiteLLMEnv(paths);
  return writeLiteLLMConfig(
    paths,
    models.filter((model) => hasLiteLLMCredentials(paths, model)),
    PROVIDER_OPTIONS,
  );
}

function litellmLogPath(paths: RuntimePaths): string {
  return path.join(paths.dataDir, "litellm_proxy.log");
}

function readLastLogLines(filePath: string, limit = 80): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split(/\r?\n/).filter(Boolean).slice(-limit);
  } catch {
    return [];
  }
}

async function getLiteLLMRuntimeStatus(
  paths: RuntimePaths,
  models: StoredModel[],
  gatewayRestartRequired: boolean,
): Promise<LiteLLMRuntimeStatus> {
  const generated = syncLiteLLMRuntimeConfig(paths, models);
  const configPath = litellmConfigPath(paths);
  const logPath = litellmLogPath(paths);
  const status: LiteLLMRuntimeStatus = {
    configured: generated.models.length > 0,
    healthy: false,
    status: generated.models.length > 0 ? "unreachable" : "unconfigured",
    base_url: generated.baseUrl,
    config_path: configPath,
    config_exists: fs.existsSync(configPath),
    log_path: logPath,
    model_count: generated.models.length,
    models: generated.models,
    gateway_restart_required: gatewayRestartRequired,
  };

  if (!status.configured) {
    return status;
  }

  try {
    const res = await fetch(`${generated.baseUrl.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(2500),
      headers: {
        Authorization: `Bearer ${resolveLiteLLMMasterKey({ workspaceDir: paths.configDir })}`,
      },
    });
    if (!res.ok) {
      status.error = `LiteLLM returned ${res.status}`;
      return status;
    }
    const body = (await res.json()) as ProviderModelsResponse;
    status.models_endpoint_count = Array.isArray(body.data)
      ? body.data.length
      : undefined;
    status.healthy = true;
    status.status = "healthy";
    return status;
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
    const tail = readLastLogLines(logPath, 8);
    const lastError = tail
      .reverse()
      .find((line) => /error|exited|traceback/i.test(line));
    if (lastError) status.error = `${status.error}; last log: ${lastError}`;
    return status;
  }
}

function skillSourceForPath(paths: RuntimePaths, skillPath: string): string {
  const normalized = path.resolve(skillPath);
  const workspaceSkills = path.resolve(paths.skillsDir);
  const bundledSkills = path.resolve(
    paths.sourceDir ?? paths.configDir,
    "packages",
    "skills",
    "src",
  );
  if (normalized.startsWith(workspaceSkills)) return "workspace";
  if (normalized.startsWith(bundledSkills)) return "builtin";
  return "global";
}

function mapSkill(paths: RuntimePaths, skill: LauncherSkillMetadata) {
  const source = skillSourceForPath(paths, String(skill.path || ""));
  let originKind = source === "builtin" ? "builtin" : "manual";
  let registryName = skill.registry_name;
  let registryUrl = skill.registry_url;
  let installedVersion = skill.version;
  let installedAt = skill.installed_at;

  if (source !== "builtin" && skill.path) {
    const marketplaceMetaPath = path.join(
      String(skill.path),
      ".marketplace.json",
    );
    try {
      if (fs.existsSync(marketplaceMetaPath)) {
        const meta = JSON.parse(fs.readFileSync(marketplaceMetaPath, "utf-8"));
        originKind = meta.origin_kind || originKind;
        registryName = meta.registry_name || registryName;
        registryUrl = meta.registry_url || registryUrl;
        installedVersion = meta.installed_version || installedVersion;
        installedAt = meta.installed_at || installedAt;
      }
    } catch {
      // ignore parse errors
    }
  }

  return {
    name: String(skill.id || skill.name || ""),
    path: String(skill.path || ""),
    source,
    description: String(skill.description || ""),
    origin_kind: originKind,
    registry_name: registryName,
    registry_url: registryUrl,
    installed_version: installedVersion,
    installed_at: installedAt,
  };
}

function readSkillContent(skillPath: string): string {
  const candidates = [
    path.join(skillPath, "SKILL.md"),
    path.join(skillPath, "README.md"),
    skillPath,
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return fs.readFileSync(candidate, "utf-8");
      }
    } catch {
      // continue
    }
  }
  return "";
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `skill-${Date.now()}`
  );
}

function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function quoteWindowsCommandArg(value: string): string {
  return value.replace(/"/g, "").replace(/([&|<>^])/g, "^$1");
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function runSkillsCli(
  paths: RuntimePaths,
  args: string[],
  timeoutMs = 120_000,
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const cliArgs = ["--yes", "skills", ...args];
  const command = npxCommand();
  const spawnCommand =
    process.platform === "win32"
      ? process.env["ComSpec"] || "cmd.exe"
      : command;
  const spawnArgs =
    process.platform === "win32"
      ? [
          "/d",
          "/s",
          "/c",
          `${command} ${cliArgs.map(quoteWindowsCommandArg).join(" ")}`,
        ]
      : cliArgs;
  const result = child_process.spawnSync(spawnCommand, spawnArgs, {
    cwd: paths.sourceDir ?? paths.configDir,
    encoding: "utf-8",
    timeout: timeoutMs,
    shell: false,
    env: {
      ...process.env,
      DISABLE_TELEMETRY: process.env["DISABLE_TELEMETRY"] || "1",
    },
  });
  return {
    ok: result.status === 0,
    stdout: stripAnsi(String(result.stdout || "")),
    stderr: stripAnsi(String(result.stderr || result.error?.message || "")),
    status: result.status,
  };
}

function parseSkillsCliFindOutput(output: string, installed: Set<string>) {
  const results: Array<{
    score: number;
    slug: string;
    id: string;
    display_name: string;
    summary: string;
    version: string;
    registry_name: string;
    url?: string;
    installed: boolean;
    installed_name?: string;
  }> = [];
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(
      /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s]+)(?:\s+(.*))?$/,
    );
    if (!match) continue;
    const source = match[1];
    const slug = match[2];
    const summary = match[3] || "";
    const urlMatch = (lines[i + 1] || "").match(/https:\/\/skills\.sh\/\S+/);
    const id = `${source}/${slug}`;
    const installedName = Array.from(installed).find(
      (name) => name === slug || name.endsWith(`/${slug}`),
    );
    results.push({
      score: 1 / (results.length + 1),
      slug,
      id,
      display_name: slug,
      summary,
      version: "latest",
      registry_name: "skills.sh",
      url: urlMatch?.[0],
      installed: Boolean(installedName),
      installed_name: installedName,
    });
  }
  return results;
}

function resolveMarketplaceSkill(input: JsonRecord): {
  source: string;
  slug: string;
  id: string;
} {
  const rawId = String(input.id || "").trim();
  const rawUrl = String(input.url || "").trim();
  const rawSlug = String(input.slug || "").trim();
  if (rawId.split("/").length >= 3) {
    const parts = rawId.split("/").filter(Boolean);
    const slug = parts.pop()!;
    return { source: parts.join("/"), slug, id: rawId };
  }
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 3) {
        const slug = parts.pop()!;
        const source = parts.join("/");
        return { source, slug, id: `${source}/${slug}` };
      }
    } catch {
      // Fall through to slug handling.
    }
  }
  if (rawSlug.includes("@")) {
    const [source, slug] = rawSlug.split("@");
    if (source && slug) return { source, slug, id: `${source}/${slug}` };
  }
  if (rawSlug.split("/").length >= 3) {
    const parts = rawSlug.split("/").filter(Boolean);
    const slug = parts.pop()!;
    const source = parts.join("/");
    return { source, slug, id: `${source}/${slug}` };
  }
  throw new Error(
    "Marketplace skill id is required. Search again and choose a listed skill.",
  );
}

function copyInstalledMarketplaceSkill(
  paths: RuntimePaths,
  slug: string,
): string {
  const sourceDir = path.join(paths.dataDir, ".agents", "skills", slug);
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`skills CLI completed, but ${sourceDir} was not created.`);
  }
  const categoryDir = path.join(paths.skillsDir, "marketplace");
  const destDir = path.join(categoryDir, slug);
  ensureDir(categoryDir);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, destDir, { recursive: true });

  const categoriesPath = path.join(paths.skillsDir, "categories.json");
  const skillsPath = path.join(categoryDir, "skills.json");
  const categories = readJsonFile<{ categories: string[] }>(categoriesPath, {
    categories: [],
  });
  if (!categories.categories.includes("marketplace"))
    categories.categories.push("marketplace");
  writeJsonFile(categoriesPath, categories);
  const skills = readJsonFile<{ skills: string[] }>(skillsPath, { skills: [] });
  if (!skills.skills.includes(slug)) skills.skills.push(slug);
  writeJsonFile(skillsPath, skills);

  const marketplaceMetaPath = path.join(destDir, ".marketplace.json");
  writeJsonFile(marketplaceMetaPath, {
    origin_kind: "third_party",
    registry_name: "skills.sh",
    installed_version: "latest",
    installed_at: Date.now(),
  });

  return destDir;
}

async function readRequestBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseMultipartFile(
  req: Request,
  body: Buffer,
): { filename: string; content: Buffer } | null {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = String(contentType).match(
    /boundary=(?:"([^"]+)"|([^;]+))/i,
  );
  if (!boundaryMatch) return null;
  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const raw = body.toString("binary");
  const parts = raw.split(boundary);
  for (const part of parts) {
    if (!part.includes('name="file"')) continue;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    const filenameMatch = headers.match(/filename="([^"]+)"/i);
    const filename = filenameMatch ? filenameMatch[1] : "skill.md";
    let content = part.slice(headerEnd + 4);
    content = content.replace(/\r\n--$/, "").replace(/\r\n$/, "");
    return { filename, content: Buffer.from(content, "binary") };
  }
  return null;
}

function toolCategory(name: string): string {
  if (/file|dir|path|read|write|edit|append/i.test(name)) return "Filesystem";
  if (/computer|screen|window|clipboard|hotkey|keyboard/i.test(name))
    return "Computer";
  if (/exec|shell|command|cron|task/i.test(name)) return "Automation";
  if (/web|browser|scrape|http|fetch|search/i.test(name)) return "Web";
  if (/message|mail|telegram|send/i.test(name)) return "Communication";
  if (/skill/i.test(name)) return "Skills";
  if (/spawn|agent/i.test(name)) return "Agents";
  if (/i2c|spi|usb|device|camera/i.test(name)) return "Hardware";
  if (/mcp|discover|find/i.test(name)) return "Discovery";
  return "General";
}

function launcherToolRisk(name: string): {
  level: "low" | "medium" | "high";
  label: string;
  reason: string;
} {
  if (/exec|shell|write|delete|computer|clipboard|hotkey|install/i.test(name)) {
    return {
      level: "high",
      label: "High risk",
      reason: "Can mutate the workspace, install code, or control local state.",
    };
  }
  if (/web|browser|scrape|http|fetch|search|mcp|discover/i.test(name)) {
    return {
      level: "medium",
      label: "Medium risk",
      reason: "Can access external content or broaden available tool surface.",
    };
  }
  return {
    level: "low",
    label: "Low risk",
    reason: "Read-only or metadata-oriented operation.",
  };
}

function readLogLines(paths: RuntimePaths): string[] {
  const files = [
    path.join(paths.dataDir, "core_backend.log"),
    path.join(paths.dataDir, "litellm_proxy.log"),
  ];
  const lines: string[] = [];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf-8");
      const label = path.basename(file);
      for (const line of content.split(/\r?\n/)) {
        if (line.trim()) lines.push(`[${label}] ${line}`);
      }
    } catch {
      // ignore unreadable logs
    }
  }
  return lines.slice(-2000);
}

async function fetchModelsFromProvider(
  provider: string,
  apiBase: string,
  apiKey: string,
): Promise<ProviderModelResult[]> {
  const option = getProviderOption(provider);
  const base = apiBase || option.default_api_base;
  if (!base) {
    return (option.common_models || []).map((id) => ({ id }));
  }
  const url = `${base.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const started = Date.now();
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`Provider returned ${response.status}`);
  }
  const elapsed = Date.now() - started;
  const body = (await response.json()) as ProviderModelsResponse;
  const rawModels = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.models)
      ? body.models
      : [];
  const models = rawModels
    .map(
      (item: unknown): ProviderModelResult =>
        typeof item === "string"
          ? { id: item }
          : item && typeof item === "object"
            ? {
                id: String(
                  (item as { id?: unknown; name?: unknown }).id ||
                    (item as { id?: unknown; name?: unknown }).name ||
                    "",
                ),
                owned_by:
                  typeof (item as { owned_by?: unknown }).owned_by === "string"
                    ? (item as { owned_by: string }).owned_by
                    : undefined,
                extra: item as JsonRecord,
              }
            : {
                id: "",
              },
    )
    .filter((item: { id: string }) => item.id);
  return models.length > 0
    ? models
    : (option.common_models || []).map((id) => ({
        id,
        extra: { latency_ms: elapsed },
      }));
}

function oauthProviderStatus(
  provider: string,
  displayName: string,
  methods: string[],
  paths: RuntimePaths,
) {
  const key =
    provider === "google-antigravity"
      ? "GEMINI_API_KEY"
      : apiKeyEnvForProvider(provider);
  const token = resolveEnvSecret(key, paths.configDir);
  return {
    provider,
    display_name: displayName,
    methods,
    logged_in: Boolean(token),
    status: token ? "connected" : "not_logged_in",
    auth_method: token ? "token" : undefined,
    account_id: token ? maskSecret(token) : undefined,
  };
}

export function createLauncherCompatRouter({
  orchestrator,
  skillLoader,
  workspaceDir: _workspaceDir,
  runtimePaths,
  reloadRuntime,
  registerRuntimeAuth,
}: LauncherCompatOptions): Router {
  const paths = runtimePaths;
  const workspaceDir = _workspaceDir ?? paths.sourceDir ?? paths.configDir;
  const dataDir = paths.dataDir;
  const statePath = path.join(dataDir, "launcher-state.json");
  const bootGatewayPort = positiveIntFromEnv("GATEWAY_PORT", 18800);
  const bootGatewayHost = process.env["GATEWAY_HOST"] || "127.0.0.1";
  ensureDir(dataDir);
  const secretVault = createWorkspaceSecretVault(paths.configDir);
  const secretMigration = migrateEnvSecretsToVault({
    workspaceDir: paths.configDir,
  });
  loadVaultSecretsIntoEnv({ workspaceDir: paths.configDir });
  const sanitizeRuntimeConfig = (config: JsonRecord): JsonRecord =>
    extractRuntimeSecretsToVault(config, secretVault, paths);
  const validateWorkspaceConfig = (config: JsonRecord) =>
    validateAndNormalizeConfig(config, {
      allowedChannelNames: pluginChannelConfigKeysFromRegistry(paths),
    });

  let state = readJsonFile<CompatState>(statePath, {});
  const runtimeConfig = runtimeConfigFromFiles(paths);
  const mergedInitialConfig = stripChannelAliases(
    mergePatch(
      mergePatch(
        defaultAppConfig(paths),
        isRecord(state.config) ? state.config : {},
      ),
      runtimeConfig,
    ),
  );
  try {
    state.config = sanitizeRuntimeConfig(
      validateWorkspaceConfig(mergedInitialConfig).config,
    );
    if (isRecord(state.config.web_search))
      state.web_search = state.config.web_search;
  } catch (err) {
    const detail =
      err instanceof ConfigValidationError
        ? configValidationMessages(err.validation).join("; ")
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(
      `[Launcher] Ignoring invalid saved/runtime config and using safe defaults: ${detail}`,
    );
    state.config = sanitizeRuntimeConfig(
      validateWorkspaceConfig(defaultAppConfig(paths)).config,
    );
    if (isRecord(state.config.web_search))
      state.web_search = state.config.web_search;
    state.gateway_restart_required = true;
  }
  state.launcher_config ??= {
    port: positiveIntFromEnv("GATEWAY_PORT", 18800),
    public: process.env["GATEWAY_HOST"] === "0.0.0.0",
    allowed_cidrs: [],
  };
  state.models ??= defaultModelsFromSettings();
  state.model_catalog ??= [];
  state.tool_state ??= {};
  // Import disabled tool state from tools.yaml so manual disables survive restart
  const toolsYamlForState = readYamlFile<JsonRecord>(
    path.join(paths.configDir, "tools.yaml"),
    {},
  );
  const yamlToolState = recordOrEmpty(toolsYamlForState.tool_state);
  const yamlDisabledTools = Array.isArray(toolsYamlForState.disabled_tools)
    ? (toolsYamlForState.disabled_tools as string[])
    : [];
  for (const [name, enabled] of Object.entries(yamlToolState)) {
    if (state.tool_state[name] === undefined) {
      state.tool_state[name] = enabled === false ? false : true;
    }
  }
  for (const name of yamlDisabledTools) {
    if (state.tool_state[name] === undefined) {
      state.tool_state[name] = false;
    }
  }
  state.web_search ??= clone(WEB_SEARCH_DEFAULT);
  state.web_search = (sanitizeRuntimeConfig({
    web_search: state.web_search,
  }).web_search || clone(WEB_SEARCH_DEFAULT)) as JsonRecord;
  state.oauth ??= {};
  state.runtime_apply_status ??= state.gateway_restart_required
    ? "pending_restart"
    : "applied";

  const saveState = () => {
    state.config = sanitizeRuntimeConfig(
      validateWorkspaceConfig(state.config || defaultAppConfig(paths)).config,
    );
    if (isRecord(state.config.web_search))
      state.web_search = state.config.web_search;
    writeJsonFile(statePath, state);
  };

  const ensurehiroToken = (): string => {
    if (!state.hiro_token) {
      state.hiro_token = crypto.randomBytes(24).toString("base64url");
      saveState();
    }
    return state.hiro_token;
  };

  registerRuntimeAuth?.({
    isDashboardAuthenticated: (headers: IncomingHttpHeaders) =>
      isAuthenticatedCookieHeader(headers.cookie),
    gethiroToken: () => state.hiro_token,
    ensurehiroToken,
  });

  const normalizedModels = state.models.map(normalizeStoredModel);
  if (JSON.stringify(normalizedModels) !== JSON.stringify(state.models)) {
    state.models = normalizedModels;
    saveState();
  }
  syncLiteLLMRuntimeConfig(paths, state.models);

  const syncConfigToRuntimeFiles = () => {
    state.config = validateWorkspaceConfig(
      state.config || defaultAppConfig(paths),
    ).config;
    const currentConfig = state.config as JsonRecord;
    const execEnabled = boolOrUndefined(
      recordOrEmpty(recordOrEmpty(currentConfig.tools).exec).enabled,
    );
    if (execEnabled != null) {
      state.tool_state ||= {};
      state.tool_state.shell_execute = execEnabled;
    }
    syncAgentYaml(paths, currentConfig);
    syncToolsYaml(paths, currentConfig, state);
    const maxTokens = numberOrUndefined(
      recordOrEmpty(recordOrEmpty(currentConfig.agents).defaults).max_tokens,
    );
    if (maxTokens != null && maxTokens > 0) {
      updateEnvVar(paths, "DEFAULT_MAX_TOKENS", String(Math.floor(maxTokens)));
    }
    const channels = recordOrEmpty(currentConfig.channels);
    const telegramConfig = recordOrEmpty(channels.telegram);
    const telegramSettings = recordOrEmpty(telegramConfig.settings);
    const telegramToken = stringOrUndefined(
      telegramSettings.token ?? telegramConfig.token,
    );
    if (telegramToken) {
      updateEnvVar(paths, "TELEGRAM_BOT_TOKEN", telegramToken);
    }
    const discordConfig = recordOrEmpty(channels.discord);
    const discordSettings = recordOrEmpty(discordConfig.settings);
    const discordToken = stringOrUndefined(
      discordSettings.token ?? discordConfig.token,
    );
    if (discordToken) {
      updateEnvVar(paths, "DISCORD_BOT_TOKEN", discordToken);
    }
    const slackConfig = recordOrEmpty(channels.slack);
    const slackSettings = recordOrEmpty(slackConfig.settings);
    const slackBotToken = stringOrUndefined(
      slackSettings.bot_token ?? slackConfig.bot_token,
    );
    const slackAppToken = stringOrUndefined(
      slackSettings.app_token ?? slackConfig.app_token,
    );
    if (slackBotToken) {
      updateEnvVar(paths, "SLACK_BOT_TOKEN", slackBotToken);
    }
    if (slackAppToken) {
      updateEnvVar(paths, "SLACK_APP_TOKEN", slackAppToken);
    }
    const lineConfig = recordOrEmpty(channels.line);
    const lineSettings = recordOrEmpty(lineConfig.settings);
    const lineToken = stringOrUndefined(lineSettings.token ?? lineConfig.token);
    const lineChannelSecret = stringOrUndefined(
      lineSettings.channel_secret ?? lineConfig.channel_secret,
    );
    if (lineToken) {
      updateEnvVar(paths, "LINE_CHANNEL_ACCESS_TOKEN", lineToken);
    }
    if (lineChannelSecret) {
      updateEnvVar(paths, "LINE_CHANNEL_SECRET", lineChannelSecret);
    }
    const whatsappConfig = recordOrEmpty(channels.whatsapp);
    const whatsappSettings = recordOrEmpty(whatsappConfig.settings);
    const whatsappBridgeUrl = stringOrUndefined(
      whatsappSettings.bridge_url ?? whatsappConfig.bridge_url,
    );
    const whatsappWebhookToken = stringOrUndefined(
      whatsappSettings.webhook_token ?? whatsappConfig.webhook_token,
    );
    if (whatsappBridgeUrl) {
      updateEnvVar(paths, "WHATSAPP_BRIDGE_URL", whatsappBridgeUrl);
    }
    if (whatsappWebhookToken) {
      updateEnvVar(paths, "WHATSAPP_WEBHOOK_TOKEN", whatsappWebhookToken);
    }
    const weixinConfig = recordOrEmpty(channels.weixin);
    const weixinSettings = recordOrEmpty(weixinConfig.settings);
    const weixinAccountId = stringOrUndefined(
      weixinSettings.account_id ?? weixinConfig.account_id,
    );
    const weixinToken = channelSecretValue(
      secretVault,
      weixinConfig,
      "weixin",
      "token",
    );
    const weixinEncodingAesKey = channelSecretValue(
      secretVault,
      weixinConfig,
      "weixin",
      "encoding_aes_key",
    );
    if (weixinAccountId) {
      updateEnvVar(paths, "WEIXIN_ACCOUNT_ID", weixinAccountId);
    }
    if (weixinToken) {
      updateEnvVar(paths, "WEIXIN_TOKEN", weixinToken);
    }
    if (weixinEncodingAesKey) {
      updateEnvVar(paths, "WEIXIN_ENCODING_AES_KEY", weixinEncodingAesKey);
    }
    const wecomConfig = recordOrEmpty(channels.wecom);
    const wecomSettings = recordOrEmpty(wecomConfig.settings);
    const wecomBotId = stringOrUndefined(
      wecomSettings.bot_id ?? wecomConfig.bot_id,
    );
    const wecomSecret = channelSecretValue(
      secretVault,
      wecomConfig,
      "wecom",
      "secret",
    );
    const wecomCorpSecret = channelSecretValue(
      secretVault,
      wecomConfig,
      "wecom",
      "corp_secret",
    );
    const wecomWebhookURL = channelSecretValue(
      secretVault,
      wecomConfig,
      "wecom",
      "webhook_url",
    );
    if (wecomBotId) {
      updateEnvVar(paths, "WECOM_BOT_ID", wecomBotId);
    }
    if (wecomSecret) {
      updateEnvVar(paths, "WECOM_SECRET", wecomSecret);
    }
    if (wecomCorpSecret) {
      updateEnvVar(paths, "WECOM_CORP_SECRET", wecomCorpSecret);
    }
    if (wecomWebhookURL) {
      updateEnvVar(paths, "WECOM_WEBHOOK_URL", wecomWebhookURL);
    }
    const onebotConfig = recordOrEmpty(channels.onebot);
    const onebotSettings = recordOrEmpty(onebotConfig.settings);
    const onebotServerUrl = stringOrUndefined(
      onebotSettings.server_url ?? onebotConfig.server_url,
    );
    const onebotAccessToken = stringOrUndefined(
      onebotSettings.access_token ?? onebotConfig.access_token,
    );
    const onebotBotId = stringOrUndefined(
      onebotSettings.bot_id ?? onebotConfig.bot_id,
    );
    if (onebotServerUrl) {
      updateEnvVar(paths, "ONEBOT_SERVER_URL", onebotServerUrl);
    }
    if (onebotAccessToken) {
      updateEnvVar(paths, "ONEBOT_ACCESS_TOKEN", onebotAccessToken);
    }
    if (onebotBotId) {
      updateEnvVar(paths, "ONEBOT_BOT_ID", onebotBotId);
    }
    const mqttConfig = recordOrEmpty(channels.mqtt);
    const mqttSettings = recordOrEmpty(mqttConfig.settings);
    const mqttBroker = stringOrUndefined(
      mqttSettings.broker ?? mqttConfig.broker,
    );
    const mqttAgentId = stringOrUndefined(
      mqttSettings.agent_id ?? mqttConfig.agent_id,
    );
    const mqttTopicPrefix = stringOrUndefined(
      mqttSettings.topic_prefix ?? mqttConfig.topic_prefix,
    );
    const mqttClientId = stringOrUndefined(
      mqttSettings.client_id ?? mqttConfig.client_id,
    );
    const mqttUsername = stringOrUndefined(
      mqttSettings.username ?? mqttConfig.username,
    );
    const mqttPassword = stringOrUndefined(
      mqttSettings.password ?? mqttConfig.password,
    );
    const mqttKeepAlive = numberOrUndefined(
      mqttSettings.keep_alive ?? mqttConfig.keep_alive,
    );
    const mqttQos = numberOrUndefined(mqttSettings.qos ?? mqttConfig.qos);
    if (mqttBroker) {
      updateEnvVar(paths, "MQTT_BROKER", mqttBroker);
    }
    if (mqttAgentId) {
      updateEnvVar(paths, "MQTT_AGENT_ID", mqttAgentId);
    }
    if (mqttTopicPrefix) {
      updateEnvVar(paths, "MQTT_TOPIC_PREFIX", mqttTopicPrefix);
    }
    if (mqttClientId) {
      updateEnvVar(paths, "MQTT_CLIENT_ID", mqttClientId);
    }
    if (mqttUsername) {
      updateEnvVar(paths, "MQTT_USERNAME", mqttUsername);
    }
    if (mqttPassword) {
      updateEnvVar(paths, "MQTT_PASSWORD", mqttPassword);
    }
    if (mqttKeepAlive != null) {
      updateEnvVar(paths, "MQTT_KEEP_ALIVE", String(mqttKeepAlive));
    }
    if (mqttQos != null) {
      updateEnvVar(paths, "MQTT_QOS", String(mqttQos));
    }
    const matrixConfig = recordOrEmpty(channels.matrix);
    const matrixSettings = recordOrEmpty(matrixConfig.settings);
    const matrixHomeserverUrl = stringOrUndefined(
      matrixSettings.homeserver_url ?? matrixConfig.homeserver_url,
    );
    const matrixUserId = stringOrUndefined(
      matrixSettings.user_id ?? matrixConfig.user_id,
    );
    const matrixAccessToken = stringOrUndefined(
      matrixSettings.access_token ?? matrixConfig.access_token,
    );
    if (matrixHomeserverUrl) {
      updateEnvVar(paths, "MATRIX_HOMESERVER_URL", matrixHomeserverUrl);
    }
    if (matrixUserId) {
      updateEnvVar(paths, "MATRIX_USER_ID", matrixUserId);
    }
    if (matrixAccessToken) {
      updateEnvVar(paths, "MATRIX_ACCESS_TOKEN", matrixAccessToken);
    }
    const ircConfig = recordOrEmpty(channels.irc);
    const ircSettings = recordOrEmpty(ircConfig.settings);
    const ircServer = stringOrUndefined(ircSettings.server ?? ircConfig.server);
    const ircPort = stringOrUndefined(ircSettings.port ?? ircConfig.port);
    const ircNick = stringOrUndefined(ircSettings.nick ?? ircConfig.nick);
    const ircPassword = stringOrUndefined(
      ircSettings.password ?? ircConfig.password,
    );
    const ircNickservPassword = stringOrUndefined(
      ircSettings.nickserv_password ?? ircConfig.nickserv_password,
    );
    const ircChannels = stringOrUndefined(
      ircSettings.channels ?? ircConfig.channels,
    );
    const ircTls = boolOrUndefined(
      ircSettings.tls ??
        ircSettings.use_tls ??
        ircConfig.tls ??
        ircConfig.use_tls,
    );
    if (ircServer) {
      updateEnvVar(paths, "IRC_SERVER", ircServer);
    }
    if (ircPort) {
      updateEnvVar(paths, "IRC_PORT", ircPort);
    }
    if (ircNick) {
      updateEnvVar(paths, "IRC_NICK", ircNick);
    }
    if (ircPassword) {
      updateEnvVar(paths, "IRC_PASSWORD", ircPassword);
    }
    if (ircNickservPassword) {
      updateEnvVar(paths, "IRC_NICKSERV_PASSWORD", ircNickservPassword);
    }
    if (ircChannels) {
      updateEnvVar(paths, "IRC_CHANNELS", ircChannels);
    }
    if (ircTls != null) {
      updateEnvVar(paths, "IRC_TLS", ircTls ? "true" : "false");
    }
    orchestrator.config = mergePatch(orchestrator.config || {}, state.config);
    if (
      isRecord(orchestrator.config.heartbeat) &&
      numberOrUndefined(orchestrator.config.heartbeat.interval) != null
    ) {
      orchestrator.config.heartbeat.interval_seconds = numberOrUndefined(
        orchestrator.config.heartbeat.interval,
      );
    }
  };

  const pendingRestartFields = (): string[] => {
    const fields: string[] = [];
    if (state.launcher_config) {
      if (state.launcher_config.port !== bootGatewayPort) {
        fields.push("gateway.port");
      }
      const desiredHost = gatewayHostForPublic(state.launcher_config.public);
      if (desiredHost !== bootGatewayHost) {
        fields.push("gateway.host");
      }
    }
    return fields;
  };

  const componentStatus = (
    components: FlowComponent[],
  ): FlowComponentStatus => {
    if (components.some((component) => component.status === "error")) {
      return "error";
    }
    if (components.some((component) => component.status === "partial")) {
      return "partial";
    }
    if (components.every((component) => component.status === "disabled")) {
      return "disabled";
    }
    return "ready";
  };

  const buildFlowStatus = async (): Promise<FlowStatusResponse> => {
    const currentConfig = recordOrEmpty(state.config);
    const toolsConfig = recordOrEmpty(currentConfig.tools);
    const mcpConfig = recordOrEmpty(toolsConfig.mcp);
    const mcpServers = recordOrEmpty(mcpConfig.servers);
    const mcpEnabled = boolOrUndefined(mcpConfig.enabled) !== false;
    const mcpDiscovery = recordOrEmpty(mcpConfig.discovery);
    const mcpDiscoveryEnabled = boolOrUndefined(mcpDiscovery.enabled) !== false;
    const configuredMcpServers = Object.values(mcpServers).filter(isRecord);
    const enabledMcpServers = configuredMcpServers.filter(
      (server) => boolOrUndefined(server.enabled) !== false,
    );
    const enabledModels = (state.models || []).filter(
      (model) => model.enabled !== false,
    );
    const pendingFields = pendingRestartFields();
    const toolDefinitions =
      typeof orchestrator.tools?.getToolDefinitions === "function"
        ? orchestrator.tools.getToolDefinitions()
        : [];
    const sessions: unknown[] = [];
    const skills = await skillLoader.getAllSkillsMetadata().catch(() => []);
    const workspaceSkills = skills.filter(
      (skill) => skillSourceForPath(paths, skill.path) === "workspace",
    );
    const runtimeApplyStatus = state.runtime_apply_status || "applied";
    const gatewayStatus: FlowComponentStatus =
      runtimeApplyStatus === "failed"
        ? "error"
        : pendingFields.length > 0
          ? "partial"
          : "ready";
    const mcpStatus: FlowComponentStatus = !mcpEnabled
      ? "disabled"
      : mcpDiscoveryEnabled || enabledMcpServers.length > 0
        ? "ready"
        : "partial";
    const pluginStatus: FlowComponentStatus =
      skills.length > 0 ? "ready" : "partial";
    const modelStatus: FlowComponentStatus =
      enabledModels.length > 0 ? "ready" : "partial";
    const authStatus: FlowComponentStatus = isAuthInitialized(state.auth)
      ? "ready"
      : "partial";

    const components: FlowComponent[] = [
      {
        id: "ui",
        label: "Web UI / CLI / App",
        status: "ready",
        summary:
          "Dashboard, REST, websocket, and channel entrypoints are mounted.",
        evidence: ["/chat", "/hiro/ws", "/api", "/webhooks/*"],
      },
      {
        id: "gateway",
        label: "Gateway",
        status: gatewayStatus,
        summary:
          pendingFields.length > 0
            ? "Runtime is live, but process-bound settings need a full restart."
            : "Gateway routes, logs, reload, and status endpoints are active.",
        evidence: [
          "/api/gateway/status",
          "/api/gateway/restart",
          "/api/runtime/reload",
          "/api/gateway/logs",
        ],
        metrics: {
          boot_port: bootGatewayPort,
          configured_port: state.launcher_config?.port || bootGatewayPort,
          pending_restart_fields: pendingFields.length,
        },
      },
      {
        id: "auth",
        label: "Auth / Session / Request Guard",
        status: authStatus,
        summary:
          "Dashboard sessions, API-key middleware, request size limits, CORS, and timeouts protect gateway entrypoints.",
        evidence: [
          "dashboard session cookie",
          "validateApiKey middleware",
          "30 MB JSON limit",
          "120 s request timeout",
        ],
      },
      {
        id: "agent_core",
        label: "Agent Core",
        status: orchestrator ? "ready" : "error",
        summary: orchestrator
          ? "Agent loop persists messages, selects model/provider, executes tools, and streams events."
          : "Agent orchestrator not initialized.",
        evidence: [
          "AgentOrchestrator.runAgentLoop",
          "ToolRegistry.executeToolStructured",
          "stream_chunk / tool_call events",
        ],
        metrics: {
          orchestrator_ready: !!orchestrator,
        },
      },
      {
        id: "memory_context",
        label: "Memory / Context",
        status: (() => {
          if (!orchestrator) return "error" as FlowComponentStatus;
          try {
            const memoryDbPath = path.join(paths.dataDir, "miki_memory.db");
            const memoryExists = fs.existsSync(memoryDbPath);
            const agentRunsDbPath = path.join(paths.dataDir, "agent-runs.db");
            const agentRunsExists = fs.existsSync(agentRunsDbPath);
            if (!memoryExists || !agentRunsExists)
              return "partial" as FlowComponentStatus;
            return "ready" as FlowComponentStatus;
          } catch {
            return "error" as FlowComponentStatus;
          }
        })(),
        summary: (() => {
          if (!orchestrator) return "Memory subsystem not available.";
          try {
            const memoryDbPath = path.join(paths.dataDir, "miki_memory.db");
            const memoryExists = fs.existsSync(memoryDbPath);
            const agentRunsDbPath = path.join(paths.dataDir, "agent-runs.db");
            const agentRunsExists = fs.existsSync(agentRunsDbPath);
            const missing = [];
            if (!memoryExists) missing.push("miki_memory.db");
            if (!agentRunsExists) missing.push("agent-runs.db");
            if (missing.length > 0)
              return `Memory DB files missing: ${missing.join(", ")}. Schema may not be initialized yet.`;
            return "Relational memory stores sessions, messages, tool logs, facts, procedures, goals, and model metadata.";
          } catch {
            return "Memory probe failed.";
          }
        })(),
        evidence: ["/memory/search", "/sessions", "miki_memory.db"],
        metrics: {
          active_sessions: sessions.length,
          memory_ready: !!orchestrator,
          memory_db_exists: (() => {
            try {
              return fs.existsSync(path.join(paths.dataDir, "miki_memory.db"));
            } catch {
              return false;
            }
          })(),
          agent_runs_db_exists: (() => {
            try {
              return fs.existsSync(path.join(paths.dataDir, "agent-runs.db"));
            } catch {
              return false;
            }
          })(),
        },
      },
      {
        id: "model",
        label: "Model Provider",
        status: modelStatus,
        summary:
          enabledModels.length > 0
            ? "Configured models are available through the model router and LiteLLM-compatible config."
            : "No enabled model is configured yet.",
        evidence: ["/api/models", "/api/litellm/status", "config/litellm.yaml"],
        metrics: {
          enabled_models: enabledModels.length,
        },
      },
      {
        id: "mcp",
        label: "MCP Tools / Resources / Prompts",
        status: mcpStatus,
        summary: !mcpEnabled
          ? "MCP is disabled in runtime config."
          : "Local tools, external MCP servers, resources, prompts, discovery, and session permissions share one MCP surface.",
        evidence: [
          "/mcp",
          "MCP resources",
          "MCP prompts",
          "tool_search discovery",
        ],
        metrics: {
          local_tools: toolDefinitions.length,
          configured_servers: configuredMcpServers.length,
          enabled_servers: enabledMcpServers.length,
          discovery_enabled: mcpDiscoveryEnabled,
        },
      },
      {
        id: "plugins_skills",
        label: "Plugins / Skills",
        status: pluginStatus,
        summary:
          "Skills load from builtin/global/workspace sources; installer supports plugin manifests, assets, registry metadata, imports, and marketplace installs.",
        evidence: [
          "/api/skills",
          "/api/skills/search",
          "/api/skills/install",
          "/api/skills/plugin-marketplace/readiness",
          "PluginManifest validation",
        ],
        metrics: {
          skills: skills.length,
          workspace_skills: workspaceSkills.length,
        },
      },
      {
        id: "system_access",
        label: "External Systems",
        status: (() => {
          if (toolDefinitions.length === 0)
            return "partial" as FlowComponentStatus;
          const toolNames = new Set(
            toolDefinitions.map((t) => String(t.function?.name || "")),
          );
          const hasCoreTools = [
            "read_file",
            "write_file",
            "list_files",
            "execute_shell",
          ].some((name) => toolNames.has(name));
          if (!hasCoreTools) return "partial" as FlowComponentStatus;
          return "ready" as FlowComponentStatus;
        })(),
        summary: (() => {
          if (toolDefinitions.length === 0)
            return "No tool handlers registered - external system access is unavailable.";
          const toolNames = new Set(
            toolDefinitions.map((t) => String(t.function?.name || "")),
          );
          const missingCore = [
            "read_file",
            "write_file",
            "list_files",
            "execute_shell",
          ].filter((name) => !toolNames.has(name));
          if (missingCore.length > 0)
            return `Core file/shell tools missing (${missingCore.join(", ")}). Limited external system access.`;
          return "File, shell, browser, computer, crawler, system index, and channel/webhook adapters execute through guarded tool handlers.";
        })(),
        evidence: [
          "/tools",
          "/tools/:name/call",
          "/webhooks/*",
          ...(toolDefinitions.length > 0 ? ["registered_tool_handlers"] : []),
        ],
        metrics: {
          registered_tools: toolDefinitions.length,
          tools_available: toolDefinitions.length > 0,
          has_core_file_tools: (() => {
            const toolNames = new Set(
              toolDefinitions.map((t) => String(t.function?.name || "")),
            );
            return ["read_file", "write_file", "list_files"].every((name) =>
              toolNames.has(name),
            );
          })(),
          has_shell_tools: (() => {
            const toolNames = new Set(
              toolDefinitions.map((t) => String(t.function?.name || "")),
            );
            return toolNames.has("execute_shell");
          })(),
        },
      },
    ];

    const gaps: FlowGap[] = [];
    if (pendingFields.length > 0) {
      gaps.push({
        id: "process-bound-gateway-settings",
        severity: "warning",
        title: "Full process restart required",
        detail: `The running process cannot hot-apply: ${pendingFields.join(", ")}.`,
        owner: "gateway",
      });
    }
    if (pluginStatus === "partial") {
      gaps.push({
        id: "skills-not-loaded",
        severity: "warning",
        title: "No effective skills loaded",
        detail:
          "Flow.md expects plugins/skills to contribute task workflows. Add or enable skills to complete that branch.",
        owner: "plugins_skills",
      });
    }
    if (mcpStatus === "partial") {
      gaps.push({
        id: "mcp-no-discovery-or-servers",
        severity: "info",
        title: "MCP discovery has no configured external server",
        detail:
          "Local tools are available, but external MCP server discovery is not configured.",
        owner: "mcp",
      });
    }
    if (modelStatus === "partial") {
      gaps.push({
        id: "no-enabled-model",
        severity: "warning",
        title: "No enabled model",
        detail:
          "Chat cannot complete the model branch until at least one model is enabled.",
        owner: "model",
      });
    }

    return {
      status: componentStatus(components),
      generated_at: new Date().toISOString(),
      flow_version: 1,
      components,
      edges: [
        { from: "ui", to: "gateway", contract: "HTTP/WebSocket request" },
        { from: "gateway", to: "auth", contract: "session and request guard" },
        { from: "auth", to: "agent_core", contract: "validated agent request" },
        {
          from: "agent_core",
          to: "memory_context",
          contract: "context read/write",
        },
        { from: "agent_core", to: "model", contract: "LLM completion" },
        {
          from: "agent_core",
          to: "mcp",
          contract: "tool/resource/prompt call",
        },
        {
          from: "agent_core",
          to: "plugins_skills",
          contract: "workflow instructions",
        },
        {
          from: "mcp",
          to: "system_access",
          contract: "guarded external action",
        },
        { from: "model", to: "agent_core", contract: "model output" },
        {
          from: "system_access",
          to: "agent_core",
          contract: "structured tool result",
        },
        { from: "agent_core", to: "gateway", contract: "streamed event" },
        { from: "gateway", to: "ui", contract: "response stream" },
      ],
      gaps,
    };
  };

  const applyRuntimeState = (
    result: RuntimeApplyResult,
  ): RuntimeApplyResult => {
    state.gateway_restart_required = result.gateway_restart_required;
    state.runtime_apply_status = result.status;
    state.runtime_apply_error = result.error;
    state.pending_restart_fields = result.pending_restart_fields;
    saveState();
    return result;
  };

  const runtimeApplyPayload = (
    status: RuntimeApplyStatus,
    pendingFields: string[],
    error?: string,
  ): RuntimeApplyResult => ({
    status,
    applied: status === "applied" || status === "pending_restart",
    pending_restart: status === "pending_restart",
    gateway_restart_required: status === "failed" || pendingFields.length > 0,
    pending_restart_fields:
      pendingFields.length > 0 ? pendingFields : undefined,
    error,
  });

  const applyRuntimeChanges = async ({
    channelsChanged = [],
    restartLiteLLM = false,
    reason = "config",
  }: {
    channelsChanged?: string[];
    restartLiteLLM?: boolean;
    reason?: string;
  } = {}): Promise<RuntimeApplyResult> => {
    try {
      if (reloadRuntime) {
        await reloadRuntime({ channelsChanged, reason });
      } else {
        await (
          orchestrator as AgentOrchestrator & {
            reloadConfig?: () => Promise<void> | void;
          }
        ).reloadConfig?.();
      }
    } catch (err) {
      return applyRuntimeState(
        runtimeApplyPayload(
          "failed",
          pendingRestartFields(),
          err instanceof Error ? err.message : String(err),
        ),
      );
    }

    let restartError: string | undefined;
    if (restartLiteLLM) {
      try {
        await restartLiteLLMThroughGateway(bootGatewayPort);
      } catch (err) {
        restartError = err instanceof Error ? err.message : String(err);
      }
    }

    try {
      const pendingFields = [
        ...pendingRestartFields(),
        ...(restartError ? ["litellm.restart"] : []),
      ];
      return applyRuntimeState(
        runtimeApplyPayload(
          pendingFields.length > 0 ? "pending_restart" : "applied",
          pendingFields,
          restartError,
        ),
      );
    } catch (err) {
      return applyRuntimeState(
        runtimeApplyPayload(
          "failed",
          pendingRestartFields(),
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  };

  const commitConfig = (
    candidateConfig: JsonRecord,
  ): { validation: ConfigValidationResult; channelsChanged: string[] } => {
    const previousConfig = clone(state.config || defaultAppConfig(paths));
    const { config, validation } = validateWorkspaceConfig(candidateConfig);
    state.config = sanitizeRuntimeConfig(config);
    if (isRecord(state.config.web_search))
      state.web_search = state.config.web_search;
    state.gateway_restart_required = true;
    syncConfigToRuntimeFiles();
    saveState();
    const channelsChanged = Array.from(
      new Set([
        ...changedChannelNames(previousConfig, candidateConfig),
        ...changedChannelNames(previousConfig, state.config),
      ]),
    );
    return {
      validation,
      channelsChanged,
    };
  };

  saveState();

  const router = Router();
  const consumedBootstrapTokens = new Set<string>();
  const qrBindingFlows = new Map<string, QrBindingFlow>();

  const gcQrBindingFlows = () => {
    const now = Date.now();
    for (const [flowID, flow] of qrBindingFlows) {
      if (
        (flow.status === "wait" || flow.status === "scaned") &&
        now > flow.expiresAt
      ) {
        flow.status = "expired";
        flow.updatedAt = now;
      }
      if (
        isTerminalQrStatus(flow.status) &&
        now - flow.updatedAt > QR_BINDING_FLOW_GC_MS
      ) {
        qrBindingFlows.delete(flowID);
      }
    }
  };

  const storeQrBindingFlow = (flow: QrBindingFlow) => {
    gcQrBindingFlows();
    qrBindingFlows.set(flow.id, flow);
  };

  const getQrBindingFlow = (
    channel: QrBindingChannel,
    flowID: string,
  ): QrBindingFlow | undefined => {
    gcQrBindingFlows();
    const flow = qrBindingFlows.get(flowID);
    return flow?.channel === channel ? flow : undefined;
  };

  const setQrBindingFlowError = (flow: QrBindingFlow, error: string) => {
    flow.status = "error";
    flow.error = error;
    flow.updatedAt = Date.now();
  };

  const saveQrBoundChannel = async (
    channel: QrBindingChannel,
    settingsPatch: JsonRecord,
  ) => {
    const currentConfig = state.config || defaultAppConfig(paths);
    const currentChannels = recordOrEmpty(currentConfig.channels);
    const currentChannel = recordOrEmpty(currentChannels[channel]);
    const currentSettings = recordOrEmpty(currentChannel.settings);
    const nextChannel = mergePatch(currentChannel, {
      enabled: true,
      type: channel,
      settings: mergePatch(currentSettings, settingsPatch),
    });
    const committed = commitConfig(
      mergePatch(currentConfig, {
        channels: {
          [channel]: nextChannel,
        },
      }),
    );
    await applyRuntimeChanges({
      channelsChanged: Array.from(
        new Set([...committed.channelsChanged, channel]),
      ),
      reason: `${channel}.qr-binding`,
    });
  };

  const fetchWeixinQrCode = async (): Promise<WeixinQrResponse> => {
    const body = await fetchJson<WeixinQrResponse>(
      weixinApiURL(WEIXIN_BASE_URL, "/ilink/bot/get_bot_qrcode", {
        bot_type: WEIXIN_BOT_TYPE,
      }),
      15_000,
    );
    if (body.errcode != null && body.errcode !== 0) {
      throw new Error(`Weixin QR error ${body.errcode}: ${body.errmsg || ""}`);
    }
    if (!body.qrcode || !body.qrcode_img_content) {
      throw new Error("Weixin QR response missing qrcode or image content.");
    }
    return body;
  };

  const pollWeixinQrStatus = async (
    flow: QrBindingFlow,
  ): Promise<WeixinQrStatusResponse> => {
    if (!flow.qrcode) {
      throw new Error("Weixin QR flow is missing qrcode token.");
    }
    const body = await fetchJson<WeixinQrStatusResponse>(
      weixinApiURL(
        flow.pollBaseURL || WEIXIN_BASE_URL,
        "/ilink/bot/get_qrcode_status",
        {
          qrcode: flow.qrcode,
        },
      ),
      10_000,
    );
    if (body.errcode != null && body.errcode !== 0) {
      throw new Error(
        `Weixin status error ${body.errcode}: ${body.errmsg || ""}`,
      );
    }
    return body;
  };

  const fetchWecomQrCode = async (): Promise<WecomQrGenerateResponse> => {
    const body = await fetchJson<WecomQrGenerateResponse>(
      urlWithQuery(WECOM_QR_GENERATE_URL, {
        source: WECOM_QR_SOURCE_ID,
        sourceID: WECOM_QR_SOURCE_ID,
        plat: wecomPlatformCode(),
      }),
      15_000,
    );
    if (body.errcode != null && body.errcode !== 0) {
      throw new Error(`WeCom QR error ${body.errcode}: ${body.errmsg || ""}`);
    }
    if (!body.data?.scode || !body.data.auth_url) {
      throw new Error("WeCom QR response missing scode or auth_url.");
    }
    return body;
  };

  const pollWecomQrStatus = async (
    flow: QrBindingFlow,
  ): Promise<WecomQrQueryResponse> => {
    if (!flow.scode) {
      throw new Error("WeCom QR flow is missing scode.");
    }
    const body = await fetchJson<WecomQrQueryResponse>(
      urlWithQuery(WECOM_QR_QUERY_URL, { scode: flow.scode }),
      10_000,
    );
    if (body.errcode != null && body.errcode !== 0) {
      throw new Error(
        `WeCom status error ${body.errcode}: ${body.errmsg || ""}`,
      );
    }
    return body;
  };

  const startWeixinQrBindingFlow = async (): Promise<QrBindingFlowResponse> => {
    const qrResponse = await fetchWeixinQrCode();
    const now = Date.now();
    const flow: QrBindingFlow = {
      id: qrBindingFlowID("weixin"),
      channel: "weixin",
      status: "wait",
      qrcode: qrResponse.qrcode,
      qrDataURI: await generateQrDataURI(qrResponse.qrcode_img_content || ""),
      pollBaseURL: WEIXIN_BASE_URL,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + QR_BINDING_FLOW_TTL_MS,
    };
    storeQrBindingFlow(flow);
    return qrBindingFlowResponse(flow);
  };

  const startWecomQrBindingFlow = async (): Promise<QrBindingFlowResponse> => {
    const qrResponse = await fetchWecomQrCode();
    const now = Date.now();
    const flow: QrBindingFlow = {
      id: qrBindingFlowID("wecom"),
      channel: "wecom",
      status: "wait",
      scode: qrResponse.data?.scode,
      qrDataURI: await generateQrDataURI(qrResponse.data?.auth_url || ""),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + QR_BINDING_FLOW_TTL_MS,
    };
    storeQrBindingFlow(flow);
    return qrBindingFlowResponse(flow);
  };

  const pollWeixinQrBindingFlow = async (
    flow: QrBindingFlow,
  ): Promise<QrBindingFlowResponse> => {
    if (isTerminalQrStatus(flow.status)) return qrBindingFlowResponse(flow);
    try {
      const statusResponse = await pollWeixinQrStatus(flow);
      const status = normalizeQrBindingStatus(statusResponse.status);
      if (statusResponse.redirect_host) {
        flow.pollBaseURL = statusResponse.redirect_host.includes("://")
          ? statusResponse.redirect_host
          : `https://${statusResponse.redirect_host}`;
      }
      if (status === "confirmed") {
        if (!statusResponse.bot_token || !statusResponse.ilink_bot_id) {
          setQrBindingFlowError(
            flow,
            "Weixin login confirmed but response is missing bot credentials.",
          );
        } else {
          await saveQrBoundChannel("weixin", {
            token: statusResponse.bot_token,
            account_id: statusResponse.ilink_bot_id,
            ...(statusResponse.baseurl
              ? { base_url: statusResponse.baseurl }
              : {}),
            ...(statusResponse.ilink_user_id
              ? { ilink_user_id: statusResponse.ilink_user_id }
              : {}),
          });
          flow.status = "confirmed";
          flow.accountId = statusResponse.ilink_bot_id;
          flow.updatedAt = Date.now();
          delete flow.qrDataURI;
        }
      } else if (status === "expired" || status === "scaned") {
        flow.status = status;
        flow.updatedAt = Date.now();
      }
    } catch {
      // Provider polling can time out while a QR session is still valid.
      flow.updatedAt = Date.now();
    }
    return qrBindingFlowResponse(flow);
  };

  const pollWecomQrBindingFlow = async (
    flow: QrBindingFlow,
  ): Promise<QrBindingFlowResponse> => {
    if (isTerminalQrStatus(flow.status)) return qrBindingFlowResponse(flow);
    try {
      const statusResponse = await pollWecomQrStatus(flow);
      const status = normalizeQrBindingStatus(statusResponse.data?.status);
      if (status === "confirmed") {
        const botID = statusResponse.data?.bot_info?.botid;
        const secret = statusResponse.data?.bot_info?.secret;
        if (!botID || !secret) {
          setQrBindingFlowError(
            flow,
            "WeCom login confirmed but response is missing bot credentials.",
          );
        } else {
          await saveQrBoundChannel("wecom", {
            bot_id: botID,
            secret,
            websocket_url: WECOM_DEFAULT_WEBSOCKET_URL,
          });
          flow.status = "confirmed";
          flow.botId = botID;
          flow.updatedAt = Date.now();
          delete flow.qrDataURI;
        }
      } else if (status === "expired" || status === "scaned") {
        flow.status = status;
        flow.updatedAt = Date.now();
      }
    } catch {
      flow.updatedAt = Date.now();
    }
    return qrBindingFlowResponse(flow);
  };

  router.use((_req, res, next) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    next();
  });

  const authStatus = (req: Request) => {
    const initialized = isAuthInitialized(state.auth);
    return {
      initialized,
      authenticated: isAuthenticated(req),
    };
  };

  const requireDashboardAuth = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const publicPaths = new Set([
      "/auth/status",
      "/auth/login",
      "/auth/logout",
      "/auth/setup",
      "/launcher-auth/status",
      "/launcher-auth/login",
      "/launcher-auth/logout",
      "/launcher-auth/setup",
    ]);
    if (
      publicPaths.has(req.path) ||
      req.path.startsWith("/launcher-auth/bootstrap/")
    ) {
      return next();
    }
    const access = dashboardAccessDecision(state.auth, isAuthenticated(req));
    if (access === "uninitialized") {
      return res
        .status(401)
        .json({ error: "Dashboard password is not initialized" });
    }
    if (access === "unauthorized") {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
  };

  const handleStatus = (req: Request, res: Response) =>
    res.json(authStatus(req));

  const handleSetup = (req: Request, res: Response) => {
    if (!canRunDashboardSetup(state.auth, isAuthenticated(req))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const password = String(req.body?.password || "").trim();
    const confirm = String(
      req.body?.confirm || req.body?.password_confirm || "",
    ).trim();
    if (password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters." });
    }
    if (confirm && password !== confirm) {
      return res
        .status(400)
        .json({ error: "Password confirmation does not match." });
    }
    const salt = crypto.randomBytes(16).toString("hex");
    state.auth = {
      salt,
      password_hash: hashPassword(password, salt),
      created_at: state.auth?.created_at || nowIso(),
      updated_at: nowIso(),
    };
    activeSessions.clear();
    saveState();
    return res.json({ status: "ok" });
  };

  const handleLogin = (req: Request, res: Response) => {
    if (!isAuthInitialized(state.auth)) {
      return res
        .status(409)
        .json({ error: "Dashboard password is not initialized" });
    }
    if (isLoginLimited(req)) {
      return res
        .status(429)
        .json({ error: "Too many failed login attempts. Try again later." });
    }
    const password = String(req.body?.password || "");
    if (!verifyPassword(password, state.auth)) {
      noteLoginFailure(req);
      return res.status(401).json({ error: "Invalid password" });
    }
    const token = crypto.randomBytes(32).toString("base64url");
    activeSessions.set(token, Date.now() + AUTH_COOKIE_MAX_AGE_SECONDS * 1000);
    loginFailures.delete(loginFailureKey(req));
    setSessionCookie(res, token);
    return res.json({ status: "ok" });
  };

  const handleLogout = (req: Request, res: Response) => {
    const token = readCookie(req, AUTH_COOKIE);
    if (token) activeSessions.delete(token);
    clearSessionCookie(res);
    return res.json({ status: "ok" });
  };

  router.get(["/auth/status", "/launcher-auth/status"], handleStatus);
  router.post(["/auth/setup", "/launcher-auth/setup"], handleSetup);
  router.post(["/auth/login", "/launcher-auth/login"], handleLogin);
  router.post(["/auth/logout", "/launcher-auth/logout"], handleLogout);
  router.get("/launcher-auth/bootstrap/:token", (req, res) => {
    if (
      !validateOneTimeBootstrapToken(
        String(req.params.token || ""),
        process.env["Hiro_LAUNCHER_BOOTSTRAP_TOKEN"],
        consumedBootstrapTokens,
      )
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const token = crypto.randomBytes(32).toString("base64url");
    activeSessions.set(token, Date.now() + AUTH_COOKIE_MAX_AGE_SECONDS * 1000);
    setSessionCookie(res, token);
    res.json({ status: "ok" });
  });

  router.use(requireDashboardAuth);
  router.use(
    "/files",
    createFileManagerRouter({
      runtimePaths: paths,
      allowSystemWrite: () => fileManagerAllowsSystemWrite(state.config),
    }),
  );

  router.post("/runtime/reload", async (_req, res) => {
    const apply = await applyRuntimeChanges({ reason: "runtime.reload" });
    res.json(apply);
  });

  router.get("/gateway/status", (_req, res) => {
    const secretStatus = inspectEnvSecretStatus({
      workspaceDir: paths.configDir,
    });
    res.json({
      gateway_status: "running",
      gateway_start_allowed: true,
      gateway_start_reason: "Gateway is managed by the running Hiro process.",
      gateway_restart_required: state.gateway_restart_required === true,
      runtime_apply_status: state.runtime_apply_status || "applied",
      runtime_apply_error: state.runtime_apply_error,
      pending_restart_fields: state.pending_restart_fields || [],
      pid: process.pid,
      boot_default_model: settings.defaultModel,
      config_default_model: settings.defaultModel,
      secret_vault: {
        migrated_from_env: secretMigration.filter((item) => item.migrated)
          .length,
        vault_secret_count: secretVault.list().length,
        env_only_secret_count: secretStatus.filter((item) => item.envOnly)
          .length,
      },
      uptime: process.uptime(),
    });
  });

  router.get("/system/flow", async (_req, res) => {
    try {
      res.json(await buildFlowStatus());
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/gateway/logs", (req, res) => {
    const offset = Number(req.query.log_offset || 0);
    const logs = readLogLines(paths);
    const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
    res.json({
      logs: logs.slice(safeOffset),
      log_total: logs.length,
      log_run_id: 1,
    });
  });

  router.get("/litellm/status", async (_req, res) => {
    try {
      const models = state.models?.length
        ? state.models
        : defaultModelsFromSettings();
      res.json(
        await getLiteLLMRuntimeStatus(
          paths,
          models,
          state.gateway_restart_required === true,
        ),
      );
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post("/litellm/sync", async (_req, res) => {
    try {
      state.models ??= defaultModelsFromSettings();
      const result = syncLiteLLMRuntimeConfig(paths, state.models);
      state.gateway_restart_required = true;
      saveState();
      const apply = await applyRuntimeChanges({
        restartLiteLLM: true,
        reason: "litellm.sync",
      });
      res.json({
        status: "ok",
        config_path: result.configPath,
        base_url: result.baseUrl,
        model_count: result.models.length,
        gateway_restart_required: apply.gateway_restart_required,
        runtime_apply_status: apply.status,
        runtime_apply_error: apply.error,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post("/litellm/restart", async (_req, res) => {
    const apply = await applyRuntimeChanges({
      restartLiteLLM: true,
      reason: "litellm.restart",
    });
    res.json({
      status: apply.status,
      gateway_restart_required: apply.gateway_restart_required,
      runtime_apply_status: apply.status,
      runtime_apply_error: apply.error,
    });
  });

  router.post(["/gateway/start", "/gateway/restart"], async (req, res) => {
    const isRestart = req.path.endsWith("restart");
    const apply = await applyRuntimeChanges({
      reason: isRestart ? "gateway.restart" : "gateway.start",
    });
    const pendingFields = apply.pending_restart_fields || [];
    const status =
      apply.status === "failed"
        ? "failed"
        : apply.pending_restart
          ? "pending_restart"
          : isRestart
            ? "reloaded"
            : "running";
    res.json({
      status,
      pid: process.pid,
      log_total: readLogLines(paths).length,
      log_run_id: 1,
      gateway_restart_required: apply.gateway_restart_required,
      runtime_apply_status: apply.status,
      runtime_apply_error: apply.error,
      pending_restart_fields: pendingFields,
      message:
        apply.pending_restart && pendingFields.length > 0
          ? `A full Hiro process restart is required to apply: ${pendingFields.join(", ")}`
          : undefined,
    });
  });

  router.post("/gateway/stop", (_req, res) => {
    res.status(200).json({
      status: "unsupported",
      supported: false,
      error:
        "Gateway stop is not supported by the in-process Node runtime. Stop Hiro with the parent process manager instead.",
      pid: process.pid,
      log_total: readLogLines(paths).length,
      log_run_id: 1,
    });
  });

  router.post("/gateway/logs/clear", (_req, res) => {
    const files = ["core_backend.log", "litellm_proxy.log"] as const;
    const results: Record<string, { ok: boolean; error?: string }> = {};
    let hasFailure = false;
    let missingFiles: string[] = [];

    for (const file of files) {
      const filePath = path.join(paths.dataDir, file);
      try {
        // Check if file exists first
        if (!fs.existsSync(filePath)) {
          missingFiles.push(file);
          results[file] = { ok: true, error: "file_missing" };
          continue;
        }
        fs.writeFileSync(filePath, "", "utf-8");
        results[file] = { ok: true };
      } catch (err) {
        hasFailure = true;
        results[file] = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (hasFailure) {
      res.status(500).json({
        status: "partial_failure",
        log_total: 0,
        log_run_id: 1,
        files: results,
      });
    } else if (missingFiles.length > 0) {
      res.status(200).json({
        status: "skipped",
        log_total: 0,
        log_run_id: 1,
        files: results,
        missing_files: missingFiles,
        message: `Skipped missing files: ${missingFiles.join(", ")}`,
      });
    } else {
      res.json({
        status: "cleared",
        log_total: 0,
        log_run_id: 1,
        files: results,
      });
    }
  });

  router.get("/sessions", (_req, res) => {
    res.json([]);
  });

  router.get("/sessions/:id/permissions", (req, res) => {
    const permissions = getSessionPermissions(req.params.id);
    const state = getSessionPermissionState(req.params.id);
    res.json({
      permissions,
      denials: state.denials,
      state,
    });
  });

  router.put("/sessions/:id/permissions", (req, res) => {
    const permissions = req.body?.permissions;
    if (!permissions || typeof permissions !== "object") {
      return res.status(400).json({
        error: "Bad request",
        detail: "permissions must be an object",
      });
    }
    setSessionPermissions(
      req.params.id,
      permissions as Record<string, boolean>,
    );
    const state = getSessionPermissionState(req.params.id);
    res.json({
      success: true,
      permissions: getSessionPermissions(req.params.id),
      denials: state.denials,
      state,
    });
  });

  router.get("/sessions/:id", (_req, res) => {
    res.status(404).json({ error: "Session not found" });
  });

  router.delete("/sessions/:id", (req, res) => {
    const sessionId = String(req.params.id || "").trim();
    if (!sessionId) {
      return res.status(400).json({ error: "session id is required" });
    }

    const cleaned = {
      messageHistory: false,
      agentTasks: false,
    };

    try {
      if (orchestrator && typeof orchestrator["_messageHistory"] === "object") {
        const history = orchestrator["_messageHistory"] as Map<string, unknown>;
        if (history.has(sessionId)) {
          history.delete(sessionId);
          cleaned.messageHistory = true;
        }
      }
    } catch {
      // best-effort cleanup
    }

    try {
      if (orchestrator && typeof orchestrator["_taskDb"] === "object") {
        const taskDb = orchestrator["_taskDb"] as {
          prepare: (sql: string) => { run: (...args: unknown[]) => void };
        };
        taskDb
          .prepare("DELETE FROM agent_tasks WHERE session_id = ?")
          .run(sessionId);
        cleaned.agentTasks = true;
      }
    } catch {
      // best-effort cleanup
    }

    res.json({ status: "ok", cleaned });
  });

  router.post("/agent/route-preview", (req, res) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      const message =
        typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        return res.status(400).json({
          success: false,
          error: "message is required",
        });
      }
      const decision = orchestrator.routeAgentTask(message);
      const acceleration = buildWorkflowAccelerationPlan(
        decision.profile,
        decision,
        {
          maxParallelToolCalls:
            orchestrator.concurrencyConfig.maxParallelToolCalls ??
            orchestrator.concurrencyConfig.maxConcurrentTasks,
        },
      );
      const decisionPattern = buildWorkflowDecisionPattern(
        decision.profile,
        decision,
        acceleration,
      );
      return res.json({
        success: true,
        data: decision,
        summary: summarizeAgentRoute(decision),
        acceleration,
        decisionPattern,
      });
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/models", async (_req, res) => {
    const models = (
      state.models && state.models.length > 0
        ? state.models
        : defaultModelsFromSettings()
    ).map((model, index) => modelInfoFromStored(model, index, paths.configDir));
    res.json({
      models,
      total: models.length,
      default_model: settings.defaultModel,
      provider_options: await launcherProviderOptions(paths),
    });
  });

  router.post("/models", async (req, res) => {
    try {
      const input = isRecord(req.body) ? req.body : {};
      const model = normalizeIncomingModel(input);
      const apiBase =
        typeof input.api_base === "string" ? input.api_base.trim() : "";
      if (apiBase) {
        validateProviderApiBase(apiBase);
      }
      const apiKey =
        typeof input.api_key === "string" ? input.api_key.trim() : "";
      if (apiKey && !isMaskedSecret(apiKey)) {
        updateEnvVar(paths, apiKeyEnvForProvider(model.provider || ""), apiKey);
      }
      state.models = [...(state.models || []), model];
      saveSupportedModels(paths, state.models);
      syncLiteLLMRuntimeConfig(paths, state.models);
      state.gateway_restart_required = true;
      saveState();
      const apply = await applyRuntimeChanges({
        restartLiteLLM: true,
        reason: "models.add",
      });
      res.json({
        status: "ok",
        index: state.models.length - 1,
        gateway_restart_required: apply.gateway_restart_required,
        runtime_apply_status: apply.status,
        runtime_apply_error: apply.error,
        pending_restart_fields: apply.pending_restart_fields || [],
      });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/models/:index", async (req, res) => {
    try {
      const index = Number(req.params.index);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= (state.models || []).length
      ) {
        return res.status(404).json({ error: "Model not found" });
      }
      const input = isRecord(req.body) ? req.body : {};
      const current = state.models![index];
      const model = normalizeIncomingModel(input, current);
      const apiBase =
        typeof input.api_base === "string"
          ? input.api_base.trim()
          : typeof model.api_base === "string"
            ? model.api_base.trim()
            : "";
      if (apiBase) {
        validateProviderApiBase(apiBase);
      }
      const apiKey =
        typeof input.api_key === "string" ? input.api_key.trim() : "";
      if (apiKey && !isMaskedSecret(apiKey)) {
        updateEnvVar(paths, apiKeyEnvForProvider(model.provider || ""), apiKey);
      }
      state.models![index] = model;
      saveSupportedModels(paths, state.models!);
      syncLiteLLMRuntimeConfig(paths, state.models!);
      state.gateway_restart_required = true;
      saveState();
      const apply = await applyRuntimeChanges({
        restartLiteLLM: true,
        reason: "models.update",
      });
      res.json({
        status: "ok",
        index,
        gateway_restart_required: apply.gateway_restart_required,
        runtime_apply_status: apply.status,
        runtime_apply_error: apply.error,
        pending_restart_fields: apply.pending_restart_fields || [],
      });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/models/:index", async (req, res) => {
    const index = Number(req.params.index);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= (state.models || []).length
    ) {
      return res.status(404).json({ error: "Model not found" });
    }
    const [removed] = state.models!.splice(index, 1);
    saveSupportedModels(paths, state.models!);
    syncLiteLLMRuntimeConfig(paths, state.models!);
    state.gateway_restart_required = true;
    saveState();
    const apply = await applyRuntimeChanges({
      restartLiteLLM: true,
      reason: "models.delete",
    });
    res.json({
      status: "ok",
      index,
      model_name: removed?.model_name,
      gateway_restart_required: apply.gateway_restart_required,
      runtime_apply_status: apply.status,
      runtime_apply_error: apply.error,
      pending_restart_fields: apply.pending_restart_fields || [],
    });
  });

  router.post("/models/default", async (req, res) => {
    const modelName = String(req.body?.model_name || "").trim();
    try {
      validateModelIdentifier(modelName);
    } catch (err) {
      return res
        .status(400)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
    updateEnvVar(paths, "DEFAULT_MODEL", modelName);
    settings.setModel(modelName);
    orchestrator.modelName = modelName;
    orchestrator.provider = normalizeProvider(undefined, modelName);
    state.gateway_restart_required = true;
    saveState();
    const apply = await applyRuntimeChanges({ reason: "models.default" });
    res.json({
      status: "ok",
      default_model: modelName,
      gateway_restart_required: apply.gateway_restart_required,
      runtime_apply_status: apply.status,
      runtime_apply_error: apply.error,
      pending_restart_fields: apply.pending_restart_fields || [],
    });
  });

  router.post("/models/test-inline", async (req, res) => {
    const input = isRecord(req.body) ? req.body : {};
    const modelName = String(input.model || "").trim();
    try {
      validateModelIdentifier(modelName);
    } catch (err) {
      return res
        .status(400)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
    const provider = normalizeProvider(String(input.provider || ""), modelName);
    const option = getProviderOption(provider);
    const apiBase = String(input.api_base || option.default_api_base || "");
    const apiKey = resolveProviderApiKey(provider, paths, input.api_key);
    const started = Date.now();
    try {
      validateProviderApiBase(apiBase);
      if (!option.empty_api_key_allowed && !apiKey) {
        return res.json({
          success: false,
          latency_ms: 0,
          status: "unconfigured",
          error: "API key is required for this provider.",
        });
      }
      if (option.supports_fetch && apiBase) {
        await fetchModelsFromProvider(provider, apiBase, apiKey);
      }
      res.json({
        success: true,
        latency_ms: Date.now() - started,
        status: "available",
      });
    } catch (err) {
      res.json({
        success: false,
        latency_ms: Date.now() - started,
        status: "unreachable",
        error: redactSecrets(err instanceof Error ? err.message : String(err), [
          apiKey,
        ]),
      });
    }
  });

  router.post("/models/:index/test", async (req, res) => {
    const index = Number(req.params.index);
    const model = state.models?.[index];
    if (!model) return res.status(404).json({ error: "Model not found" });
    const provider = normalizeProvider(model.provider, model.model_name);
    const option = getProviderOption(provider);
    const apiBase = model.api_base || option.default_api_base;
    const apiKey = resolveProviderApiKey(provider, paths);
    const started = Date.now();
    try {
      validateProviderApiBase(apiBase);
      if (!option.empty_api_key_allowed && !apiKey) {
        return res.json({
          success: false,
          latency_ms: 0,
          status: "unconfigured",
          error: "API key is required for this provider.",
        });
      }
      await fetchModelsFromProvider(provider, apiBase, apiKey);
      res.json({
        success: true,
        latency_ms: Date.now() - started,
        status: "available",
      });
    } catch (err) {
      res.json({
        success: false,
        latency_ms: Date.now() - started,
        status: "unreachable",
        error: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  router.post("/models/fetch", async (req, res) => {
    const provider = normalizeProvider(String(req.body?.provider || ""));
    const option = getProviderOption(provider);
    const apiKey = resolveProviderApiKey(provider, paths, req.body?.api_key);
    const apiBase = String(req.body?.api_base || option.default_api_base || "");
    if (!option.empty_api_key_allowed && !apiKey) {
      return res
        .status(400)
        .json({ error: "API key is required for this provider." });
    }
    try {
      validateProviderApiBase(apiBase);
      const models = await fetchModelsFromProvider(provider, apiBase, apiKey);
      const entry: CatalogEntry = {
        id: crypto.randomUUID(),
        provider,
        api_base: apiBase,
        api_key_mask: maskSecret(apiKey),
        models,
        fetched_at: nowIso(),
      };
      state.model_catalog = [entry, ...(state.model_catalog || [])].slice(
        0,
        25,
      );
      saveState();
      res.json({ models, total: models.length });
    } catch (err) {
      res.status(502).json({
        error: redactSecrets(err instanceof Error ? err.message : String(err), [
          apiKey,
        ]),
      });
    }
  });

  router.get("/models/catalog", (_req, res) => {
    res.json({
      entries: state.model_catalog || [],
      total: state.model_catalog?.length || 0,
    });
  });

  router.delete("/models/catalog/:id", (req, res) => {
    const catalog = state.model_catalog || [];
    const existingIndex = catalog.findIndex(
      (entry) => entry.id === req.params.id,
    );
    if (existingIndex === -1) {
      return res.status(404).json({ error: "Catalog entry not found" });
    }
    state.model_catalog = catalog.filter((entry) => entry.id !== req.params.id);
    saveState();
    res.json({ deleted: req.params.id });
  });

  router.get("/oauth/providers", (_req, res) => {
    res.json({
      providers: [
        oauthProviderStatus("openai", "OpenAI", ["token"], paths),
        oauthProviderStatus("anthropic", "Anthropic", ["token"], paths),
        oauthProviderStatus(
          "google-antigravity",
          "Google Antigravity",
          ["token"],
          paths,
        ),
      ],
    });
  });

  router.post("/oauth/login", async (req, res) => {
    const provider = String(req.body?.provider || "");
    const method = String(req.body?.method || "token");
    if (!provider)
      return res.status(400).json({ error: "provider is required" });
    if (method === "token") {
      const token = String(req.body?.token || "").trim();
      if (!token) return res.status(400).json({ error: "token is required" });
      const envKey =
        provider === "google-antigravity"
          ? "GEMINI_API_KEY"
          : apiKeyEnvForProvider(provider);
      updateEnvVar(paths, envKey, token);
      state.oauth![provider] = { method: "token", updated_at: nowIso() };
      state.gateway_restart_required = true;
      saveState();
      const apply = await applyRuntimeChanges({
        reason: `oauth.login.${provider}`,
      });
      return res.json({
        status: "ok",
        provider,
        method,
        gateway_restart_required: apply.gateway_restart_required,
        runtime_apply_status: apply.status,
        runtime_apply_error: apply.error,
      });
    }
    const flowId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    state.oauth![flowId] = {
      provider,
      method,
      status: "pending",
      expires_at: expiresAt,
    };
    saveState();
    return res.json({
      status: "pending",
      provider,
      method,
      flow_id: flowId,
      auth_url: "https://platform.openai.com/api-keys",
      user_code: flowId.slice(0, 8).toUpperCase(),
      verify_url: "https://platform.openai.com/api-keys",
      interval: 5,
      expires_at: expiresAt,
    });
  });

  router.get("/oauth/flows/:flowId", (req, res) => {
    const flow = state.oauth?.[req.params.flowId];
    if (!flow) return res.status(404).json({ error: "Flow not found" });
    res.json({ flow_id: req.params.flowId, ...flow });
  });

  router.post("/oauth/flows/:flowId/poll", (req, res) => {
    const flow = state.oauth?.[req.params.flowId];
    if (!flow) return res.status(404).json({ error: "Flow not found" });
    const expiresAt = Date.parse(String(flow.expires_at || ""));
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      flow.status = "expired";
      saveState();
    }
    res.json({ flow_id: req.params.flowId, ...flow });
  });

  router.post("/oauth/logout", async (req, res) => {
    const provider = String(req.body?.provider || "");
    if (!provider)
      return res.status(400).json({ error: "provider is required" });
    const envKey =
      provider === "google-antigravity"
        ? "GEMINI_API_KEY"
        : apiKeyEnvForProvider(provider);
    updateEnvVar(paths, envKey, "");
    delete state.oauth?.[provider];
    state.gateway_restart_required = true;
    saveState();
    const apply = await applyRuntimeChanges({
      reason: `oauth.logout.${provider}`,
    });
    res.json({
      status: "ok",
      provider,
      gateway_restart_required: apply.gateway_restart_required,
      runtime_apply_status: apply.status,
      runtime_apply_error: apply.error,
    });
  });

  router.get("/oauth/token/:provider", (req, res) => {
    const provider = String(req.params.provider || "");
    if (!provider) {
      return res.status(400).json({ error: "provider is required" });
    }
    const envKey =
      provider === "google-antigravity"
        ? "GEMINI_API_KEY"
        : apiKeyEnvForProvider(provider);
    const token = resolveEnvSecret(envKey, paths.configDir);
    if (!token) {
      return res.status(404).json({ error: "Token not configured" });
    }
    res.json({ token });
  });

  const listLauncherChannels = async (): Promise<
    SupportedChannelMetadata[]
  > => {
    const pluginChannels = await listRuntimePluginChannelMetadata(workspaceDir);
    const seen = new Set<string>();
    for (const channel of SUPPORTED_CHANNELS) {
      seen.add(channel.name);
      seen.add(channel.config_key);
    }
    return [
      ...SUPPORTED_CHANNELS,
      ...pluginChannels.filter((channel) => {
        if (seen.has(channel.name) || seen.has(channel.config_key)) {
          return false;
        }
        seen.add(channel.name);
        seen.add(channel.config_key);
        return true;
      }),
    ];
  };

  const resolveChannel = async (
    name: string,
  ): Promise<ResolvedChannel | undefined> => {
    const builtIn = SUPPORTED_CHANNELS.find((item) => item.name === name);
    if (builtIn) {
      return {
        source: "builtin",
        channel: builtIn,
        secretFields: CHANNEL_SECRET_FIELDS[builtIn.name] || [],
      };
    }
    const descriptor = await findRuntimePluginChannelDescriptor(
      workspaceDir,
      name,
    );
    if (!descriptor) return undefined;
    return {
      source: "plugin",
      channel: descriptor.metadata,
      descriptor,
      secretFields: descriptor.secretFields,
    };
  };

  const configuredSecretsForResolvedChannel = (
    resolved: ResolvedChannel,
    raw: JsonRecord,
  ): string[] => {
    if (resolved.source === "builtin") {
      return Array.from(
        new Set([
          ...configuredSecretsForChannel(resolved.channel.name, raw),
          ...configuredSecretsFromVault(secretVault, resolved.channel.name),
        ]),
      );
    }
    return Array.from(
      new Set([
        ...configuredSecretFieldsFromRaw(raw, resolved.secretFields),
        ...configuredSecretFieldsFromVault(
          secretVault,
          resolved.channel.config_key,
          resolved.secretFields,
        ),
        ...configuredSecretFieldsFromVault(
          secretVault,
          resolved.channel.name,
          resolved.secretFields,
        ),
      ]),
    );
  };

  router.get("/channels/catalog", async (_req, res) => {
    try {
      res.json({ channels: await listLauncherChannels() });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get("/config", (_req, res) => {
    res.json(stripChannelAliases(state.config || defaultAppConfig(paths)));
  });

  router.post("/config/validate", (req, res) => {
    if (!isRecord(req.body))
      return res.status(400).json({ error: "JSON object expected" });
    const validation = validateRuntimeConfig(stripChannelAliases(req.body), {
      allowedChannelNames: pluginChannelConfigKeysFromRegistry(paths),
    });
    res.json(configValidationSummary(validation));
  });

  router.post("/config/test-command-patterns", (req, res) => {
    if (!isRecord(req.body))
      return res.status(400).json({ error: "JSON object expected" });

    const { allow_patterns, deny_patterns, command } = req.body as {
      allow_patterns?: string[];
      deny_patterns?: string[];
      command?: string;
    };

    if (typeof command !== "string") {
      return res.status(400).json({ error: "command is required" });
    }

    const lower = command.toLowerCase().trim();
    const result = {
      allowed: false,
      blocked: false,
      matched_whitelist: undefined as string | undefined,
      matched_blacklist: undefined as string | undefined,
    };

    // Check whitelist first
    if (Array.isArray(allow_patterns)) {
      for (const pattern of allow_patterns) {
        try {
          const re = new RegExp(pattern);
          if (re.test(lower)) {
            result.allowed = true;
            result.matched_whitelist = pattern;
            return res.json(result);
          }
        } catch {
          // Skip invalid patterns
          continue;
        }
      }
    }

    // Check blacklist
    if (Array.isArray(deny_patterns)) {
      for (const pattern of deny_patterns) {
        try {
          const re = new RegExp(pattern);
          if (re.test(lower)) {
            result.blocked = true;
            result.matched_blacklist = pattern;
            break;
          }
        } catch {
          // Skip invalid patterns
          continue;
        }
      }
    }

    res.json(result);
  });

  router.put("/config", async (req, res) => {
    if (!isRecord(req.body))
      return res.status(400).json({ error: "JSON object expected" });
    try {
      const committed = commitConfig(req.body);
      const apply = await applyRuntimeChanges({
        channelsChanged: committed.channelsChanged,
        reason: "config.put",
      });
      res.json({
        status: "ok",
        validation: configValidationSummary(committed.validation),
        gateway_restart_required: apply.gateway_restart_required,
        runtime_apply_status: apply.status,
        runtime_apply_error: apply.error,
      });
    } catch (err) {
      sendConfigValidationError(res, err);
    }
  });

  router.patch("/config", async (req, res) => {
    if (!isRecord(req.body))
      return res.status(400).json({ error: "JSON object expected" });
    const patch = { ...req.body } as JsonRecord;
    if (isRecord(patch.channel_list)) {
      patch.channels = mergePatch(
        isRecord((state.config || {}).channels)
          ? ((state.config || {}).channels as JsonRecord)
          : {},
        patch.channel_list,
      );
      delete patch.channel_list;
    }
    try {
      const committed = commitConfig(
        mergePatch(state.config || defaultAppConfig(paths), patch),
      );
      const apply = await applyRuntimeChanges({
        channelsChanged: committed.channelsChanged,
        reason: "config.patch",
      });
      res.json({
        status: "ok",
        validation: configValidationSummary(committed.validation),
        gateway_restart_required: apply.gateway_restart_required,
        runtime_apply_status: apply.status,
        runtime_apply_error: apply.error,
      });
    } catch (err) {
      sendConfigValidationError(res, err);
    }
  });

  router.post("/config/reset", async (_req, res) => {
    try {
      const committed = commitConfig(defaultAppConfig(paths));
      const apply = await applyRuntimeChanges({
        channelsChanged: committed.channelsChanged,
        reason: "config.reset",
      });
      res.json({
        status: "ok",
        validation: configValidationSummary(committed.validation),
        gateway_restart_required: apply.gateway_restart_required,
        runtime_apply_status: apply.status,
        runtime_apply_error: apply.error,
      });
    } catch (err) {
      sendConfigValidationError(res, err);
    }
  });

  router.get("/channels/:name/config", async (req, res) => {
    try {
      const resolved = await resolveChannel(req.params.name);
      if (!resolved) {
        return res.status(404).json({ error: "Channel not found" });
      }
      const { channel } = resolved;
      const channels = isRecord(state.config?.channels)
        ? (state.config!.channels as JsonRecord)
        : {};
      const raw = isRecord(channels[channel.config_key])
        ? (channels[channel.config_key] as JsonRecord)
        : {};
      const safeRaw =
        resolved.source === "builtin"
          ? stripConfiguredSecretFields(raw, channel.name)
          : stripSecretFields(raw, resolved.secretFields);
      const flattened = flattenChannelConfig(safeRaw, channel);
      res.json({
        config: flattened,
        configured_secrets: configuredSecretsForResolvedChannel(resolved, raw),
        config_key: channel.config_key,
        variant: channel.variant,
        source: resolved.source,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get("/channels/:name/probe", async (req, res) => {
    try {
      const resolved = await resolveChannel(req.params.name);
      if (!resolved) {
        return res.status(404).json({ error: "Channel not found" });
      }
      const { channel } = resolved;
      const channels = isRecord(state.config?.channels)
        ? (state.config!.channels as JsonRecord)
        : {};
      const raw = isRecord(channels[channel.config_key])
        ? (channels[channel.config_key] as JsonRecord)
        : {};
      const safeRaw =
        resolved.source === "builtin"
          ? stripConfiguredSecretFields(raw, channel.name)
          : stripSecretFields(raw, resolved.secretFields);
      const flattened = flattenChannelConfig(safeRaw, channel);
      const configuredSecrets = configuredSecretsForResolvedChannel(
        resolved,
        raw,
      );
      const mode = parseChannelProbeMode(req.query["mode"]);

      if (resolved.source === "plugin") {
        const probe = await probeRuntimePluginChannel(
          workspaceDir,
          resolved.channel.name,
          flattened,
          { configuredSecrets, mode },
        );
        if (!probe) {
          return res.status(404).json({ error: "Channel not found" });
        }
        return res.json(probe);
      }

      const extraChecks =
        channel.name === "telegram" && mode === "live"
          ? await runTelegramLiveProbe(raw, flattened, secretVault)
          : [];
      return res.json(
        buildChannelRuntimeProbe({
          channel,
          config: flattened,
          configuredSecrets,
          hashiroToken: Boolean(state.hiro_token),
          mode,
          extraChecks,
        }),
      );
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post("/weixin/flows", async (_req, res) => {
    try {
      res.json(await startWeixinQrBindingFlow());
    } catch (err) {
      res.status(502).json({
        status: "error",
        error: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  });
  router.get("/weixin/flows/:id", async (req, res) => {
    const flow = getQrBindingFlow("weixin", String(req.params.id || ""));
    if (!flow) return res.status(404).json({ error: "flow not found" });
    try {
      res.json(await pollWeixinQrBindingFlow(flow));
    } catch (err) {
      setQrBindingFlowError(
        flow,
        redactSecrets(err instanceof Error ? err.message : String(err)),
      );
      res.json(qrBindingFlowResponse(flow));
    }
  });
  router.post("/wecom/flows", async (_req, res) => {
    try {
      res.json(await startWecomQrBindingFlow());
    } catch (err) {
      res.status(502).json({
        status: "error",
        error: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  });
  router.get("/wecom/flows/:id", async (req, res) => {
    const flow = getQrBindingFlow("wecom", String(req.params.id || ""));
    if (!flow) return res.status(404).json({ error: "flow not found" });
    try {
      res.json(await pollWecomQrBindingFlow(flow));
    } catch (err) {
      setQrBindingFlowError(
        flow,
        redactSecrets(err instanceof Error ? err.message : String(err)),
      );
      res.json(qrBindingFlowResponse(flow));
    }
  });

  const hiroInfo = (req: Request) => {
    ensurehiroToken();
    const protocol =
      req.headers["x-forwarded-proto"] === "https" ? "wss" : "ws";
    const host = req.headers.host || `127.0.0.1:${settings.corePort}`;
    return {
      ws_url: `${protocol}://${host}/hiro/ws`,
      enabled: true,
      configured: true,
    };
  };

  router.get("/hiro/info", (req, res) => {
    res.json(hiroInfo(req));
  });

  router.post("/hiro/token", (req, res) => {
    state.hiro_token = crypto.randomBytes(24).toString("base64url");
    saveState();
    res.json(hiroInfo(req));
  });

  router.post("/hiro/setup", async (req, res) => {
    const info = hiroInfo(req);
    const channels = {
      ...(isRecord(state.config?.channels)
        ? (state.config!.channels as JsonRecord)
        : {}),
    };
    channels.hiro = {
      enabled: true,
      type: "hiro",
      settings: {
        token: state.hiro_token,
        ws_url: info.ws_url,
        streaming: { enabled: true },
      },
    };
    try {
      const committed = commitConfig({ ...(state.config || {}), channels });
      const apply = await applyRuntimeChanges({
        channelsChanged: committed.channelsChanged,
        reason: "hiro.setup",
      });
      res.json({
        ...info,
        changed: true,
        validation: configValidationSummary(committed.validation),
        gateway_restart_required: apply.gateway_restart_required,
        runtime_apply_status: apply.status,
        runtime_apply_error: apply.error,
      });
    } catch (err) {
      sendConfigValidationError(res, err);
    }
  });

  router.get("/skills", async (_req, res) => {
    const skills = await skillLoader.getAllSkillsMetadata();
    res.json({ skills: skills.map((skill) => mapSkill(paths, skill)) });
  });

  router.get("/skills/search", async (req, res) => {
    const query = String(req.query.q || "");
    if (!query.trim()) {
      return res.json({ results: [], limit: 20, offset: 0, has_more: false });
    }
    try {
      const limit = Number(req.query.limit || 20);
      const offset = Number(req.query.offset || 0);
      const installed = new Set(
        (await skillLoader.getAllSkillsMetadata()).map(
          (skill) => skill.id || skill.name,
        ),
      );
      const cli = runSkillsCli(paths, ["find", query], 60_000);
      if (!cli.ok && !cli.stdout) {
        throw new Error(cli.stderr || "skills CLI search failed");
      }
      const all = parseSkillsCliFindOutput(cli.stdout, installed);
      res.json({
        results: all.slice(offset, offset + limit),
        limit,
        offset,
        next_offset: offset + limit < all.length ? offset + limit : undefined,
        has_more: offset + limit < all.length,
      });
    } catch (err) {
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/skills/install", async (req, res) => {
    try {
      const input = isRecord(req.body) ? req.body : {};
      const skill = resolveMarketplaceSkill(input);
      const cli = runSkillsCli(
        paths,
        [
          "add",
          skill.source,
          "--skill",
          skill.slug,
          "--agent",
          "codex",
          "--copy",
          "-y",
        ],
        180_000,
      );
      if (!cli.ok) {
        return res.status(502).json({
          error: cli.stderr || cli.stdout || "skills CLI install failed",
        });
      }
      const destDir = copyInstalledMarketplaceSkill(paths, skill.slug);
      const installedVersion = String(input.version || "latest");
      const marketplaceMetaPath = path.join(destDir, ".marketplace.json");
      writeJsonFile(marketplaceMetaPath, {
        origin_kind: "third_party",
        registry_name: "skills.sh",
        registry_url: `https://skills.sh/${skill.id}`,
        installed_version: installedVersion,
        installed_at: Date.now(),
      });
      skillLoader.refreshCache();
      res.json({
        status: "ok",
        slug: skill.slug,
        registry: "skills.sh",
        version: installedVersion,
        summary: cli.stdout.split(/\r?\n/).filter(Boolean).slice(-6).join("\n"),
        skill: {
          name: `marketplace/${skill.slug}`,
          path: destDir,
          source: "workspace",
          description: "",
          origin_kind: "third_party",
          registry_name: "skills.sh",
          registry_url: `https://skills.sh/${skill.id}`,
          installed_version: String(input.version || "latest"),
          installed_at: Date.now(),
        },
      });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/skills/import", async (req, res) => {
    try {
      const body = await readRequestBody(req);
      const file = parseMultipartFile(req, body);
      if (!file) return res.status(400).json({ error: "No file uploaded" });
      if (file.content.length > 1024 * 1024) {
        return res.status(400).json({ error: "Skill file is larger than 1MB" });
      }
      const lower = file.filename.toLowerCase();
      if (!lower.endsWith(".md")) {
        return res.status(400).json({
          error: "Only Markdown skill imports are supported in this build.",
        });
      }
      const content = file.content.toString("utf-8");
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const name = slugify(
        titleMatch?.[1] ||
          path.basename(file.filename, path.extname(file.filename)),
      );
      const skillDir = path.join(workspaceDir, "src", "skills", "manual", name);
      ensureDir(skillDir);
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf-8");
      const categoriesPath = path.join(
        workspaceDir,
        "src",
        "skills",
        "categories.json",
      );
      const manualSkillsPath = path.join(
        workspaceDir,
        "src",
        "skills",
        "manual",
        "skills.json",
      );
      ensureDir(path.dirname(categoriesPath));
      ensureDir(path.dirname(manualSkillsPath));
      const categories = readJsonFile<{ categories: string[] }>(
        categoriesPath,
        { categories: [] },
      );
      if (!categories.categories.includes("manual"))
        categories.categories.push("manual");
      writeJsonFile(categoriesPath, categories);
      const skills = readJsonFile<{ skills: string[] }>(manualSkillsPath, {
        skills: [],
      });
      if (!skills.skills.includes(name)) skills.skills.push(name);
      writeJsonFile(manualSkillsPath, skills);
      skillLoader.refreshCache();
      res.json({
        status: "ok",
        name: `manual/${name}`,
        path: skillDir,
        source: "workspace",
        description: "",
        origin_kind: "manual",
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/skills/plugin-marketplace/readiness", async (req, res) => {
    try {
      const pluginName =
        typeof req.query.plugin === "string" && req.query.plugin.trim()
          ? req.query.plugin.trim()
          : undefined;
      const includeNonPluginSkills =
        typeof req.query.includeNonPluginSkills === "string" &&
        req.query.includeNonPluginSkills.toLowerCase() === "true";
      const report = await buildPluginMarketplaceReadinessReport(workspaceDir, {
        pluginName,
        includeNonPluginSkills,
      });

      res.json({
        success: true,
        data: report.data,
        total: report.total,
        summary: report.summary,
        generatedAt: report.generatedAt,
        skillsDir: report.skillsDir,
        configPath: report.configPath,
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/skills/:name", async (req, res, next) => {
    const name = decodeURIComponent(req.params.name);
    const RESERVED_SKILL_ROUTES = new Set([
      "categories",
      "tags",
      "plugin-contracts",
      "search",
      "install",
      "import",
      "plugin-marketplace",
      "stats",
    ]);
    if (RESERVED_SKILL_ROUTES.has(name)) {
      return next();
    }
    const skills = await skillLoader.getAllSkillsMetadata();
    const skill = skills.find((item) => item.id === name || item.name === name);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    res.json({
      ...mapSkill(paths, skill),
      content: readSkillContent(skill.path),
    });
  });

  router.delete("/skills/:name", async (req, res, next) => {
    const name = decodeURIComponent(req.params.name);
    const RESERVED_SKILL_ROUTES = new Set([
      "categories",
      "tags",
      "plugin-contracts",
      "search",
      "install",
      "import",
      "plugin-marketplace",
      "stats",
    ]);
    if (RESERVED_SKILL_ROUTES.has(name)) {
      return next();
    }
    const skills = await skillLoader.getAllSkillsMetadata();
    const skill = skills.find((item) => item.id === name || item.name === name);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    const source = skillSourceForPath(paths, skill.path);
    if (source !== "workspace") {
      return res
        .status(403)
        .json({ error: "Only workspace skills can be deleted." });
    }
    fs.rmSync(skill.path, { recursive: true, force: true });
    skillLoader.refreshCache();
    res.json({ status: "ok", name, source: "workspace" });
  });

  router.get("/tools", (_req, res) => {
    const definitions = orchestrator.tools.getToolDefinitions();
    const tools = definitions.map((definition) => {
      const name = definition.function.name;
      const enabled = state.tool_state?.[name] !== false;
      return {
        name,
        description: definition.function.description,
        category: toolCategory(name),
        config_key: name,
        status: enabled ? "enabled" : "disabled",
        risk: definition.risk,
      };
    });
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of [
      "web_search",
      "tool_search_tool_regex",
      "tool_search_tool_bm25",
      "find_skills",
      "install_skill",
    ]) {
      if (!names.has(name)) {
        const currentConfig = recordOrEmpty(state.config);
        const mcp = recordOrEmpty(recordOrEmpty(currentConfig.tools).mcp);
        const discovery = recordOrEmpty(mcp.discovery);
        const mcpEnabled = boolOrUndefined(mcp.enabled) !== false;
        const discoveryEnabled = boolOrUndefined(discovery.enabled) !== false;
        const discoveryMethodEnabled =
          name === "tool_search_tool_regex"
            ? boolOrUndefined(discovery.use_regex) === true
            : name === "tool_search_tool_bm25"
              ? boolOrUndefined(discovery.use_bm25) !== false
              : true;
        const status =
          name.startsWith("tool_search_tool_") && !mcpEnabled
            ? "disabled"
            : name.startsWith("tool_search_tool_") && !discoveryEnabled
              ? "blocked"
              : name.startsWith("tool_search_tool_") && !discoveryMethodEnabled
                ? "disabled"
                : state.tool_state?.[name] === false
                  ? "disabled"
                  : "enabled";
        tools.push({
          name,
          description:
            name === "web_search"
              ? "Search the web from the agent."
              : name === "tool_search_tool_regex"
                ? "Discover available MCP tools by regex search."
                : name === "tool_search_tool_bm25"
                  ? "Discover available MCP tools by BM25-style lexical ranking."
                  : name === "find_skills"
                    ? "Search available skills in registries."
                    : name === "install_skill"
                      ? "Install a skill from a registry into the workspace."
                      : "Discovery tool",
          category: name.startsWith("tool_search_tool_")
            ? "Discovery"
            : name === "web_search"
              ? "Web"
              : "Skills",
          config_key: name,
          status,
          risk: launcherToolRisk(name),
        });
      }
    }
    res.json({ tools });
  });

  router.put("/tools/:name/state", async (req, res) => {
    const enabled = req.body?.enabled === true;
    const previousToolState = clone(state.tool_state || {});
    const previousConfig = clone(state.config || defaultAppConfig(paths));
    state.tool_state = { ...previousToolState, [req.params.name]: enabled };
    let candidateConfig = state.config || defaultAppConfig(paths);
    if (req.params.name === "shell_execute") {
      candidateConfig = mergePatch(candidateConfig, {
        tools: { exec: { enabled } },
      });
    }
    if (
      req.params.name === "tool_search_tool_regex" ||
      req.params.name === "tool_search_tool_bm25"
    ) {
      const discoveryPatch =
        req.params.name === "tool_search_tool_regex"
          ? { use_regex: enabled }
          : { use_bm25: enabled };
      const mcpPatch: JsonRecord = {
        discovery: {
          ...discoveryPatch,
        },
      };
      if (enabled) {
        mcpPatch.enabled = true;
        (mcpPatch.discovery as JsonRecord).enabled = true;
      }
      candidateConfig = mergePatch(candidateConfig, {
        tools: { mcp: mcpPatch },
      });
    }
    try {
      const committed = commitConfig(candidateConfig);
      const apply = await applyRuntimeChanges({
        reason: `tools.${req.params.name}`,
      });
      res.json({
        status: "ok",
        validation: configValidationSummary(committed.validation),
        gateway_restart_required: apply.gateway_restart_required,
        runtime_apply_status: apply.status,
        runtime_apply_error: apply.error,
      });
    } catch (err) {
      state.tool_state = previousToolState;
      state.config = previousConfig;
      sendConfigValidationError(res, err);
    }
  });

  router.get("/tools/web-search-config", (_req, res) => {
    res.json(state.web_search || WEB_SEARCH_DEFAULT);
  });

  router.put("/tools/web-search-config", async (req, res) => {
    if (!isRecord(req.body))
      return res.status(400).json({ error: "JSON object expected" });
    const previousWebSearch = clone(state.web_search || WEB_SEARCH_DEFAULT);
    const previousConfig = clone(state.config || defaultAppConfig(paths));
    state.web_search = req.body;
    try {
      const committed = commitConfig(
        mergePatch(state.config || defaultAppConfig(paths), {
          web_search: req.body,
        }),
      );
      const apply = await applyRuntimeChanges({
        reason: "tools.web_search",
      });
      res.json({
        ...(state.web_search || WEB_SEARCH_DEFAULT),
        gateway_restart_required: apply.gateway_restart_required,
        runtime_apply_status: apply.status,
        runtime_apply_error: apply.error,
        validation: configValidationSummary(committed.validation),
      });
    } catch (err) {
      state.web_search = previousWebSearch;
      state.config = previousConfig;
      sendConfigValidationError(res, err);
    }
  });

  router.get("/system/autostart", (_req, res) => {
    const supported = autostartSupported();
    const enabled = supported
      ? platformAutostartEnabled()
      : state.autostart?.enabled === true;
    res.json({
      enabled,
      supported,
      platform: os.platform(),
      message: supported
        ? "Launch-at-login is managed by the native OS autostart mechanism."
        : "Launch-at-login is not supported for this operating system in this build.",
    });
  });

  router.put("/system/autostart", (req, res) => {
    try {
      const enabled = req.body?.enabled === true;
      if (autostartSupported()) {
        setPlatformAutostart(paths, enabled);
      }
      state.autostart = { enabled };
      saveState();
      res.json({
        enabled: autostartSupported() ? platformAutostartEnabled() : enabled,
        supported: autostartSupported(),
        platform: os.platform(),
        message: autostartSupported()
          ? "Launch-at-login updated."
          : "Preference saved; OS autostart is not supported for this platform.",
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/system/launcher-config", (_req, res) => {
    res.json(state.launcher_config);
  });

  router.put("/system/launcher-config", (req, res) => {
    const port = Number(req.body?.port);
    const allowed = Array.isArray(req.body?.allowed_cidrs)
      ? req.body.allowed_cidrs.filter(
          (item: unknown): item is string => typeof item === "string",
        )
      : [];
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res
        .status(400)
        .json({ error: "port must be between 1 and 65535" });
    }
    state.launcher_config = {
      port,
      public: req.body?.public === true,
      allowed_cidrs: allowed,
    };
    updateEnvVar(paths, "GATEWAY_PORT", String(port));
    updateEnvVar(
      paths,
      "GATEWAY_HOST",
      state.launcher_config.public ? "0.0.0.0" : "127.0.0.1",
    );
    const apply = applyRuntimeState(
      runtimeApplyPayload("pending_restart", pendingRestartFields()),
    );
    res.json({
      ...state.launcher_config,
      gateway_restart_required: apply.gateway_restart_required,
      runtime_apply_status: apply.status,
      pending_restart_fields: apply.pending_restart_fields || [],
    });
  });

  router.get("/system/version", (_req, res) => {
    const pkg = readJsonFile<{ version?: string }>(
      path.join(workspaceDir, "package.json"),
      {},
    );
    res.json({
      version: pkg.version || "1.0.0",
      git_commit: process.env["GIT_COMMIT"],
      build_time: process.env["BUILD_TIME"],
      go_version: `node ${process.version}`,
    });
  });

  router.get("/system/stats", (_req, res) => {
    res.json(getSystemStats());
  });

  return router;
}
