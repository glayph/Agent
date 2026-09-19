import { builtinProviderPlugins } from "./providers/builtin/index.js";
import type { MikiProviderPlugin } from "../llm/provider/sdk/index.js";
import { builtinChannelRegistry } from "./channels/builtin-channel-registry.js";
import {
  PluginRegistry,
  pluginManifest,
  type PluginDescriptor,
  type PluginManifest,
  type PluginRuntimeStatus,
} from "./sdk/index.js";
import { agentToAgentPlugin } from "./agent-to-agent/index.js";
import { authenticationPlugin } from "./authentication/index.js";
import { browserPlugin } from "./browser/index.js";
import { codeExecutionPlugin } from "./code-execution/index.js";
import { computerUsePlugin } from "./computer-use/index.js";
import { guardrailsPlugin } from "./guardrails/index.js";
import { integrationsPlugin } from "./integrations/index.js";
import { knowledgePlugin } from "./knowledge/index.js";
import { mcpPlugin } from "../mcp/plugin.js";
import { memoryPlugin } from "../memory/plugin.js";
import { modelRouterPlugin } from "./model-router/index.js";
import { notificationsPlugin } from "./notifications/index.js";
import { observabilityPlugin } from "../observability/plugin.js";
import { schedulerPlugin } from "./scheduler/index.js";
import { searchPlugin } from "../search/plugin.js";
import { securityPlugin } from "../security/plugin.js";
import { storagePlugin } from "./storage/index.js";
import { toolsPlugin } from "../tools/plugin.js";
import { workflowPlugin } from "./workflow/index.js";

export type BuiltinPluginFamily = "provider" | "channel" | "capability";

export interface BuiltinPluginCatalogEntry {
  family: BuiltinPluginFamily;
  manifest: PluginManifest;
  descriptor?: PluginDescriptor;
}

function providerManifest(plugin: MikiProviderPlugin): PluginManifest {
  const capabilities = plugin.manifest.capabilities;
  const permissions =
    plugin.auth.mode === "local" || plugin.auth.mode === "none"
      ? []
      : (["network", "secrets"] as const);
  const runtimeStatus: PluginRuntimeStatus = plugin.manifest.capabilities.local
    ? "functional"
    : "partial";
  return pluginManifest({
    id: `provider.${plugin.manifest.id}`,
    displayName: plugin.manifest.displayName,
    version: plugin.manifest.version,
    capabilities: ["ai-provider"],
    runtimeStatus,
    description: `AI provider Plug-in (${capabilities.chat ? "chat" : "catalog-only"}).`,
    configKey: plugin.manifest.id,
    requiredConfig: plugin.auth.allowEmptyKey ? [] : plugin.auth.envVars || [],
    secretFields: plugin.auth.secretFields || plugin.auth.envVars || [],
    permissions,
    platform: ["any"],
    metadata: {
      providerId: plugin.manifest.id,
      modelPrefixes: plugin.manifest.modelPrefixes || [],
      modelIds: plugin.manifest.modelIds || [],
      local: plugin.manifest.capabilities.local,
    },
  });
}

function channelManifestToPlugin(
  manifest: ReturnType<typeof builtinChannelRegistry.manifests>[number],
): PluginManifest {
  return pluginManifest({
    id: `channel.${manifest.name}`,
    displayName: manifest.display_name,
    version: "1.0.0",
    capabilities: ["channel"],
    runtimeStatus: manifest.runtime_status,
    description: manifest.runtime_note,
    configKey: manifest.config_key,
    requiredConfig: manifest.required_fields,
    secretFields: manifest.secret_fields,
    permissions: ["network", "secrets"],
    platform: ["any"],
    metadata: {
      webhookPath: manifest.webhook_path,
    },
  });
}

const capabilityDescriptors: PluginDescriptor[] = [
  authenticationPlugin,
  browserPlugin,
  computerUsePlugin,
  codeExecutionPlugin,
  mcpPlugin,
  memoryPlugin,
  knowledgePlugin,
  storagePlugin,
  securityPlugin,
  schedulerPlugin,
  workflowPlugin,
  integrationsPlugin,
  searchPlugin,
  notificationsPlugin,
  modelRouterPlugin,
  observabilityPlugin,
  guardrailsPlugin,
  agentToAgentPlugin,
  toolsPlugin,
];

export const builtinCapabilityRegistry = new PluginRegistry(
  capabilityDescriptors,
);

export const builtinPluginCatalog: readonly BuiltinPluginCatalogEntry[] = [
  ...builtinProviderPlugins.map((plugin) => ({
    family: "provider" as const,
    manifest: providerManifest(plugin),
  })),
  ...builtinChannelRegistry.manifests().map((manifest) => ({
    family: "channel" as const,
    manifest: channelManifestToPlugin(manifest),
  })),
  ...capabilityDescriptors.map((descriptor) => ({
    family: "capability" as const,
    manifest: descriptor.manifest,
    descriptor,
  })),
];

const catalogIds = new Set<string>();
for (const entry of builtinPluginCatalog) {
  if (catalogIds.has(entry.manifest.id)) {
    throw new Error(
      `Duplicate built-in plugin catalog id: ${entry.manifest.id}`,
    );
  }
  catalogIds.add(entry.manifest.id);
}

export function listBuiltinPluginManifests(): PluginManifest[] {
  return builtinPluginCatalog.map((entry) => ({
    ...entry.manifest,
    capabilities: [...entry.manifest.capabilities],
    requiredConfig: entry.manifest.requiredConfig
      ? [...entry.manifest.requiredConfig]
      : undefined,
    secretFields: entry.manifest.secretFields
      ? [...entry.manifest.secretFields]
      : undefined,
    permissions: entry.manifest.permissions
      ? [...entry.manifest.permissions]
      : undefined,
    platform: entry.manifest.platform
      ? [...entry.manifest.platform]
      : undefined,
    metadata: entry.manifest.metadata
      ? { ...entry.manifest.metadata }
      : undefined,
  }));
}

export function getBuiltinPluginManifest(
  id: string,
): PluginManifest | undefined {
  return builtinPluginCatalog.find((entry) => entry.manifest.id === id)
    ?.manifest;
}
