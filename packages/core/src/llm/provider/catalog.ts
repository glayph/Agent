import { resolveConfiguredSecret } from "@miki/config";
import { builtinProviderPlugins } from "./sdk/builtin.js";
import { providerClient, type ProviderTransportConfig } from "./transport.js";
import type OpenAI from "openai";

export type DirectProviderId = string;
export type DirectProviderConfig = ProviderTransportConfig;

function endpointForPlugin(
  plugin: (typeof builtinProviderPlugins)[number],
): DirectProviderConfig {
  return {
    id: plugin.manifest.id,
    displayName: plugin.manifest.displayName,
    baseUrl: plugin.manifest.ui?.defaultApiBase || "",
    apiKeyEnv: plugin.auth.envVars?.[0] || "",
    emptyApiKeyAllowed: plugin.auth.allowEmptyKey,
    local: plugin.manifest.capabilities.local,
  };
}

/**
 * Compatibility view for older core callers. The canonical provider registry
 * is the Plug-in registry; this array contains no provider implementation or
 * vendor-specific behavior and is derived from built-in Plug-in manifests.
 */
export const DIRECT_PROVIDERS: DirectProviderConfig[] =
  builtinProviderPlugins.map(endpointForPlugin);

function pluginMatchesProvider(
  plugin: (typeof builtinProviderPlugins)[number],
  value: string,
): boolean {
  const normalized = value.trim().toLowerCase();
  const manifest = plugin.manifest;
  return (
    manifest.id.toLowerCase() === normalized ||
    (manifest.aliases || []).some(
      (alias) => alias.toLowerCase() === normalized,
    ) ||
    (manifest.modelPrefixes || []).some(
      (prefix) => prefix.toLowerCase() === normalized,
    )
  );
}

function pluginForProvider(value: string) {
  return builtinProviderPlugins.find((plugin) =>
    pluginMatchesProvider(plugin, value),
  );
}

function pluginForModel(value: string) {
  const normalized = value.trim().toLowerCase();
  return builtinProviderPlugins.find((plugin) => {
    const manifest = plugin.manifest;
    return (
      manifest.modelIds?.some((id) => id.toLowerCase() === normalized) ||
      manifest.modelPrefixes?.some((prefix) => {
        const candidate = prefix.toLowerCase();
        return (
          normalized === candidate ||
          normalized.startsWith(`${candidate}/`) ||
          normalized.startsWith(`${candidate}-`)
        );
      })
    );
  });
}

export function getDirectProviderById(
  id: string,
): DirectProviderConfig | undefined {
  const plugin = pluginForProvider(id);
  return plugin ? endpointForPlugin(plugin) : undefined;
}

export function directProviderForModel(
  model: string,
): DirectProviderConfig | undefined {
  const plugin = pluginForModel(model);
  return plugin ? endpointForPlugin(plugin) : undefined;
}

export function normalizeDirectModelName(
  providerId: string,
  model: string,
): string {
  const plugin = pluginForProvider(providerId);
  if (!plugin) return model;
  const prefixes = [
    plugin.manifest.id,
    ...(plugin.manifest.aliases || []),
    ...(plugin.manifest.modelPrefixes || []),
  ]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let normalized = model.trim();
  for (const prefix of prefixes) {
    if (normalized.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) {
      normalized = normalized.slice(prefix.length + 1);
      break;
    }
  }
  return normalized;
}

export function resolveProviderApiKey(
  provider: DirectProviderConfig,
  workspaceDir?: string,
): string {
  if (!provider.apiKeyEnv) return "";
  return (
    resolveConfiguredSecret(provider.apiKeyEnv, workspaceDir) ||
    resolveConfiguredSecret(provider.apiKeyEnv)
  );
}

export function directProviderClient(
  provider: DirectProviderConfig,
  apiKey: string,
  timeoutMs?: number,
): OpenAI {
  return providerClient(provider, apiKey, timeoutMs);
}

export interface DirectProviderModel {
  id: string;
  owned_by?: string;
}

/** Generic OpenAI-compatible model discovery retained for compatibility. */
export async function fetchDirectProviderModels(
  provider: DirectProviderConfig,
  apiKey: string,
  timeoutMs?: number,
): Promise<DirectProviderModel[]> {
  const client = directProviderClient(provider, apiKey, timeoutMs);
  const response = await client.models.list();
  return (response.data || []).map((item) => {
    const ownedBy = (item as { owned_by?: unknown }).owned_by;
    return {
      id: item.id,
      ...(typeof ownedBy === "string" ? { owned_by: ownedBy } : {}),
    };
  });
}

export async function testDirectProviderConnection(
  provider: DirectProviderConfig,
  apiKey: string,
  timeoutMs?: number,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await fetchDirectProviderModels(provider, apiKey, timeoutMs);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
