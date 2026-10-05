import {
  PluginRegistry,
  pluginManifest,
  type ManagedPlugin,
  type PluginCapability,
  type PluginDescriptor,
  type PluginHealth,
  type PluginManifest,
  type PluginPermission,
  type PluginRuntimeStatus,
} from "./sdk/index.js";

export type BuiltinPluginFamily = "provider" | "channel" | "capability";

export interface BuiltinPluginEntry {
  family: BuiltinPluginFamily;
  manifest: PluginManifest;
}

type Seed = {
  id: string;
  name: string;
  capability: PluginCapability;
  status: PluginRuntimeStatus;
  description: string;
  permissions?: PluginPermission[];
  secrets?: string[];
  configKey?: string;
};

const seed = (family: BuiltinPluginFamily, item: Seed): BuiltinPluginEntry => ({
  family,
  manifest: pluginManifest({
    id: item.id,
    displayName: item.name,
    version: "1.0.0",
    capabilities: [item.capability],
    runtimeStatus: item.status,
    description: item.description,
    ...(item.configKey ? { configKey: item.configKey } : {}),
    ...(item.secrets ? { secretFields: item.secrets } : {}),
    ...(item.permissions ? { permissions: item.permissions } : {}),
    platform: ["any"],
    metadata: { family, builtin: true },
  }),
});

const providers: Seed[] = [
  {
    id: "provider.openai-compatible",
    name: "OpenAI-compatible",
    capability: "ai-provider",
    status: "functional",
    description:
      "Any chat-completions endpoint that follows the OpenAI wire format.",
    permissions: ["network", "secrets"],
    secrets: ["api_key"],
  },
  {
    id: "provider.openai",
    name: "OpenAI",
    capability: "ai-provider",
    status: "functional",
    description: "OpenAI models through the chat-completions API.",
    permissions: ["network", "secrets"],
    secrets: ["api_key"],
  },
  {
    id: "provider.openrouter",
    name: "OpenRouter",
    capability: "ai-provider",
    status: "functional",
    description: "OpenRouter's multi-model gateway.",
    permissions: ["network", "secrets"],
    secrets: ["api_key"],
  },
  {
    id: "provider.gemini",
    name: "Google Gemini",
    capability: "ai-provider",
    status: "partial",
    description: "Gemini models through the provider compatibility layer.",
    permissions: ["network", "secrets"],
    secrets: ["api_key"],
  },
  {
    id: "provider.llama-cpp",
    name: "llama.cpp (local)",
    capability: "ai-provider",
    status: "partial",
    description: "Local GGUF models served by the bundled llama.cpp runtime.",
    permissions: ["filesystem-read", "shell"],
  },
];

const channels: Seed[] = [
  {
    id: "channel.telegram",
    name: "Telegram",
    capability: "channel",
    status: "partial",
    description:
      "Telegram bot adapter; connection flow is still being completed.",
    permissions: ["network", "secrets"],
    secrets: ["bot_token"],
  },
  {
    id: "channel.discord",
    name: "Discord",
    capability: "channel",
    status: "partial",
    description:
      "Discord bot adapter; connection flow is still being completed.",
    permissions: ["network", "secrets"],
    secrets: ["bot_token"],
  },
  {
    id: "channel.slack",
    name: "Slack",
    capability: "channel",
    status: "partial",
    description:
      "Slack Socket Mode adapter; connection flow is still being completed.",
    permissions: ["network", "secrets"],
    secrets: ["bot_token", "app_token"],
  },
  {
    id: "channel.webhook",
    name: "Webhook",
    capability: "channel",
    status: "partial",
    description: "Generic inbound/outbound webhook.",
    permissions: ["network"],
  },
  {
    id: "channel.whatsapp",
    name: "WhatsApp",
    capability: "channel",
    status: "config_only",
    description:
      "WhatsApp Business connection definition; no live runtime yet.",
    permissions: ["network", "secrets"],
    secrets: ["access_token"],
  },
  {
    id: "channel.facebook",
    name: "Facebook",
    capability: "channel",
    status: "config_only",
    description: "Facebook page connection definition; no live runtime yet.",
    permissions: ["network", "secrets"],
    secrets: ["access_token"],
  },
  {
    id: "channel.instagram",
    name: "Instagram",
    capability: "channel",
    status: "config_only",
    description: "Instagram connection definition; no live runtime yet.",
    permissions: ["network", "secrets"],
    secrets: ["access_token"],
  },
  {
    id: "channel.youtube",
    name: "YouTube",
    capability: "channel",
    status: "config_only",
    description: "YouTube connection definition; no live runtime yet.",
    permissions: ["network", "secrets"],
    secrets: ["access_token"],
  },
  {
    id: "channel.linkedin",
    name: "LinkedIn",
    capability: "channel",
    status: "config_only",
    description: "LinkedIn connection definition; no live runtime yet.",
    permissions: ["network", "secrets"],
    secrets: ["access_token"],
  },
  {
    id: "channel.x",
    name: "X",
    capability: "channel",
    status: "config_only",
    description: "X (Twitter) connection definition; no live runtime yet.",
    permissions: ["network", "secrets"],
    secrets: ["access_token"],
  },
  {
    id: "channel.email",
    name: "Email",
    capability: "channel",
    status: "unsupported",
    description: "Planned. No adapter exists yet.",
  },
  {
    id: "channel.sms",
    name: "SMS",
    capability: "channel",
    status: "unsupported",
    description: "Planned. No adapter exists yet.",
  },
];

const capabilities: Seed[] = [
  {
    id: "tools.core-registry",
    name: "Agent tool registry",
    capability: "tool",
    status: "functional",
    description:
      "Dynamic tool registry used by the agent engine (files, memory, skills, control).",
    permissions: ["filesystem-read", "filesystem-write"],
  },
  {
    id: "workflow.agent-loop",
    name: "Agent loop",
    capability: "workflow",
    status: "functional",
    description:
      "Plan, tool-call, approval and cancel lifecycle of an agent run.",
  },
  {
    id: "storage.local",
    name: "Local storage",
    capability: "storage",
    status: "functional",
    description: "Workspace files and the SQLite runtime database.",
    permissions: ["filesystem-read", "filesystem-write"],
  },
  {
    id: "code-execution.runtime-fetch",
    name: "Script execution",
    capability: "code-execution",
    status: "partial",
    description:
      "Sandboxed script runner with timeout, output cap and approval gate.",
    permissions: ["shell", "filesystem-write"],
  },
  {
    id: "mcp.server",
    name: "MCP server",
    capability: "mcp",
    status: "partial",
    description: "Exposes Miki tools over the Model Context Protocol.",
    permissions: ["mcp", "network"],
  },
  {
    id: "memory.temporal-knowledge-graph",
    name: "Long-term memory",
    capability: "memory",
    status: "partial",
    description:
      "SQLite memory chunks with lexical search; no vector or graph retrieval yet.",
    permissions: ["filesystem-read", "filesystem-write"],
  },
  {
    id: "search.web",
    name: "Web search",
    capability: "search",
    status: "disabled",
    description: "Web search providers are not wired in yet.",
    permissions: ["network"],
  },
  {
    id: "browser.playwright",
    name: "Browser automation",
    capability: "browser",
    status: "partial",
    description: "Playwright-based browser sessions.",
    permissions: ["browser", "network"],
  },
  {
    id: "computer-use.native",
    name: "Computer use",
    capability: "computer-use",
    status: "partial",
    description: "Screen and input control adapter.",
    permissions: ["computer-use"],
  },
  {
    id: "knowledge.documents",
    name: "Knowledge base",
    capability: "knowledge",
    status: "partial",
    description: "Document knowledge adapter.",
    permissions: ["filesystem-read"],
  },
  {
    id: "authentication.core",
    name: "Dashboard authentication",
    capability: "authentication",
    status: "partial",
    description:
      "Password and session cookie for the dashboard; no CSRF or rate limiting yet.",
    permissions: ["secrets"],
  },
  {
    id: "security.workspace-policy",
    name: "Workspace security policy",
    capability: "security",
    status: "partial",
    description:
      "Protected paths, secret-file blocking and execution kill switch.",
  },
  {
    id: "scheduler.cron",
    name: "Scheduler",
    capability: "scheduler",
    status: "config_only",
    description:
      "Scheduled and background task triggers; runtime wiring is pending.",
  },
  {
    id: "integration.platform-connections",
    name: "Platform connections",
    capability: "integration",
    status: "config_only",
    description:
      "Social platform connection records; OAuth completion is pending.",
    permissions: ["network", "secrets"],
  },
  {
    id: "notification.approvals",
    name: "Approval notifications",
    capability: "notification",
    status: "partial",
    description: "Delivers approval requests to the dashboard.",
  },
  {
    id: "model-router.registry",
    name: "Model router",
    capability: "model-router",
    status: "partial",
    description: "Picks a configured model per run.",
  },
  {
    id: "observability.audit-log",
    name: "Audit and metrics",
    capability: "observability",
    status: "partial",
    description: "Audit log, structured logs and metrics collectors.",
  },
  {
    id: "guardrail.safety",
    name: "Safety guardrails",
    capability: "guardrail",
    status: "partial",
    description: "Approval gating and secret redaction for tool output.",
  },
  {
    id: "agent-to-agent.swarm",
    name: "Agent swarm",
    capability: "agent-to-agent",
    status: "partial",
    description: "Agent registry and message bus.",
    permissions: ["agent-delegation"],
  },
];

export const builtinPluginCatalog: readonly BuiltinPluginEntry[] = [
  ...providers.map((item) => seed("provider", item)),
  ...channels.map((item) => seed("channel", item)),
  ...capabilities.map((item) => seed("capability", item)),
];

function descriptorFor(entry: BuiltinPluginEntry): PluginDescriptor {
  return {
    manifest: entry.manifest,
    create: (): ManagedPlugin => ({
      health: () => staticHealth(entry.manifest),
    }),
  };
}

/** Descriptors of the capability family, kept in a registry that rejects duplicate ids. */
export const builtinCapabilityRegistry = new PluginRegistry(
  builtinPluginCatalog
    .filter((entry) => entry.family === "capability")
    .map(descriptorFor),
);

export function listBuiltinPluginManifests(): PluginManifest[] {
  return builtinPluginCatalog.map((entry) => entry.manifest);
}

export function getBuiltinPluginManifest(
  id: string,
): PluginManifest | undefined {
  return builtinPluginCatalog.find((entry) => entry.manifest.id === id)
    ?.manifest;
}

/** Health derived only from the declared status. Live probes are layered on top by the host. */
export function staticHealth(manifest: PluginManifest): PluginHealth {
  const ok =
    manifest.runtimeStatus === "functional" ||
    manifest.runtimeStatus === "partial";
  return {
    ok,
    status: manifest.runtimeStatus,
    message: ok ? undefined : `Runtime status is ${manifest.runtimeStatus}.`,
  };
}

export function listBuiltinPluginHealth(
  overrides: Readonly<Record<string, PluginHealth>> = {},
): Record<string, PluginHealth> {
  const out: Record<string, PluginHealth> = {};
  for (const manifest of listBuiltinPluginManifests())
    out[manifest.id] = overrides[manifest.id] ?? staticHealth(manifest);
  return out;
}
