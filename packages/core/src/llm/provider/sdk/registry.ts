import type { LLMResponse } from "@miki/config";
import {
  MIKI_PROVIDER_PLUGIN_API_VERSION,
  type MikiProviderCompletionRequest,
  type MikiProviderContext,
  type MikiProviderEndpoint,
  type MikiProviderManifest,
  type MikiProviderMessage,
  type MikiProviderPlugin,
  type ProviderPluginDescriptor,
} from "./index.js";
import { LLMAPIError } from "../errors.js";
import { ProviderPluginLoader } from "./loader.js";

export interface ProviderPluginRegistryOptions {
  workspaceDir: string;
  configDir: string;
  mikiVersion?: string;
  apiVersion?: string;
  resolveCredentials?: (
    auth: MikiProviderPlugin["auth"],
    providerId: string,
  ) => Promise<Record<string, string>> | Record<string, string>;
  logger?: (event: string, details?: Record<string, unknown>) => void;
  externalPluginDirectory?: string;
  allowExternalPlugins?: boolean;
}

function apiMajor(version: string): number | null {
  const match = /^(?:v)?(\d+)(?:\.|$)/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

function normalizeModel(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function endpointFromCatalog(
  manifest: MikiProviderManifest,
  auth: MikiProviderPlugin["auth"],
  catalog: Awaited<ReturnType<MikiProviderPlugin["catalog"]>>,
): MikiProviderEndpoint {
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    baseUrl: catalog?.baseUrl || "",
    apiKeyEnv: auth.envVars?.[0],
    emptyApiKeyAllowed: auth.allowEmptyKey,
    authMode: auth.mode,
    local: manifest.capabilities.local,
  };
}

export class ProviderPluginRegistry {
  private readonly plugins = new Map<string, MikiProviderPlugin>();
  private readonly sources = new Map<string, "builtin" | "external">();
  private readonly options: Required<
    Pick<
      ProviderPluginRegistryOptions,
      "workspaceDir" | "configDir" | "mikiVersion" | "apiVersion"
    >
  > &
    ProviderPluginRegistryOptions;

  constructor(options: ProviderPluginRegistryOptions) {
    this.options = {
      ...options,
      mikiVersion: options.mikiVersion || process.env.MIKI_VERSION || "1.3.3",
      apiVersion: options.apiVersion || MIKI_PROVIDER_PLUGIN_API_VERSION,
    };
  }

  private context(): MikiProviderContext {
    return {
      workspaceDir: this.options.workspaceDir,
      configDir: this.options.configDir,
      mikiVersion: this.options.mikiVersion,
      log: (event, details) => {
        this.options.logger?.(event, { providerRegistry: true, ...details });
      },
    };
  }

  register(
    plugin: MikiProviderPlugin,
    source: "builtin" | "external" = "builtin",
  ): void {
    const id = plugin?.manifest?.id?.trim().toLowerCase();
    if (!id) throw new Error("provider plugin manifest id is required");
    if (!plugin.complete || !plugin.catalog)
      throw new Error(`provider plugin ${id} is missing required hooks`);
    if (
      apiMajor(plugin.manifest.pluginApiVersion) !==
      apiMajor(this.options.apiVersion)
    ) {
      throw new Error(
        `provider plugin ${id} targets incompatible plugin API ${plugin.manifest.pluginApiVersion}`,
      );
    }
    if (this.plugins.has(id))
      throw new Error(`duplicate provider plugin id: ${id}`);
    this.plugins.set(id, plugin);
    this.sources.set(id, source);
    this.options.logger?.("provider.plugin.ready", {
      providerId: id,
      version: plugin.manifest.version,
      source,
    });
  }

  unregister(providerId: string): Promise<void> {
    const id = normalizeModel(providerId);
    const plugin = this.plugins.get(id);
    this.plugins.delete(id);
    this.options.logger?.("provider.plugin.removed", { providerId: id });
    return plugin?.shutdown ? plugin.shutdown() : Promise.resolve();
  }

  get(providerId: string): MikiProviderPlugin | undefined {
    return this.plugins.get(normalizeModel(providerId));
  }

  descriptors(): ProviderPluginDescriptor[] {
    return Array.from(this.plugins.values()).map((plugin) => ({
      manifest: plugin.manifest,
      auth: plugin.auth,
      source: this.sources.get(plugin.manifest.id) || "builtin",
      readiness: "ready",
    }));
  }

  resolve(model: string): MikiProviderPlugin | undefined {
    const normalized = normalizeModel(model);
    const prefix = normalized.split("/", 1)[0];
    const direct = this.plugins.get(prefix) || this.plugins.get(normalized);
    if (direct) return direct;
    for (const plugin of this.plugins.values()) {
      if (
        plugin.manifest.modelIds?.some(
          (id) => normalizeModel(id) === normalized,
        )
      )
        return plugin;
      if (
        plugin.manifest.modelPrefixes?.some(
          (value) =>
            normalized === normalizeModel(value) ||
            normalized.startsWith(`${normalizeModel(value)}/`) ||
            normalized.startsWith(`${normalizeModel(value)}-`),
        )
      )
        return plugin;
    }
    return this.plugins.get("openrouter");
  }

  async loadExternalPlugins(
    directory = this.options.externalPluginDirectory,
  ): Promise<ProviderPluginDescriptor[]> {
    if (!directory || this.options.allowExternalPlugins !== true) return [];
    const loader = new ProviderPluginLoader({
      externalDirectory: directory,
      allowExternal: true,
      allowedExternalPermissions: ["network"],
      mikiVersion: this.options.mikiVersion,
      pluginApiVersion: this.options.apiVersion,
    });
    const loaded: ProviderPluginDescriptor[] = [];
    for (const record of loader.discover()) {
      if (record.descriptor.readiness !== "ready") {
        loaded.push(record.descriptor);
        continue;
      }
      loaded.push({
        ...record.descriptor,
        readiness: "metadata_only",
        reason:
          "external provider entrypoints require the bounded runtime-contract executor; direct in-process loading is disabled",
      });
    }
    return loaded;
  }

  async catalog(
    providerId: string,
  ): Promise<Awaited<ReturnType<MikiProviderPlugin["catalog"]>> | null> {
    const plugin = this.get(providerId);
    if (!plugin) return null;
    return plugin.catalog(this.context());
  }

  async complete(
    model: string,
    messages: MikiProviderMessage[],
    options: {
      extra?: Record<string, unknown>;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<LLMResponse> {
    const plugin = this.resolve(model);
    if (!plugin)
      throw new LLMAPIError(`No provider plugin matches model "${model}".`);
    const catalog = await plugin.catalog(this.context());
    if (!catalog)
      throw new LLMAPIError(
        `Provider plugin ${plugin.manifest.id} has no available catalog.`,
        { providerId: plugin.manifest.id },
      );
    const credentials = this.options.resolveCredentials
      ? await this.options.resolveCredentials(plugin.auth, plugin.manifest.id)
      : {};
    const endpoint = endpointFromCatalog(plugin.manifest, plugin.auth, catalog);
    const request: MikiProviderCompletionRequest = {
      provider: endpoint,
      model,
      messages,
      credentials,
      extra: options.extra,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      context: this.context(),
    };
    this.options.logger?.("provider.plugin.complete", {
      providerId: plugin.manifest.id,
      model,
      messageCount: messages.length,
    });
    return plugin.complete(request);
  }

  async shutdown(): Promise<void> {
    for (const plugin of this.plugins.values()) await plugin.shutdown?.();
    this.plugins.clear();
  }
}
