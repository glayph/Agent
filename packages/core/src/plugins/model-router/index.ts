import {
  providerRegistry,
  type ProviderRegistry,
} from "../../llm/provider/registry.js";
import type { MikiProviderMessage } from "../../llm/provider/sdk/index.js";
import {
  pluginManifest,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
} from "../sdk/index.js";

export interface ModelRouterPluginRuntime extends ManagedPlugin {
  readonly providers: ProviderRegistry;
  resolve(model: string): ReturnType<ProviderRegistry["resolve"]>;
  complete(
    model: string,
    messages: MikiProviderMessage[],
    extra?: Record<string, unknown>,
  ): ReturnType<ProviderRegistry["complete"]>;
}

class ModelRouterRuntime implements ModelRouterPluginRuntime {
  constructor(readonly providers: ProviderRegistry) {}

  resolve(model: string): ReturnType<ProviderRegistry["resolve"]> {
    return this.providers.resolve(model);
  }

  complete(
    model: string,
    messages: MikiProviderMessage[],
    extra?: Record<string, unknown>,
  ): ReturnType<ProviderRegistry["complete"]> {
    return this.providers.complete(model, messages, extra);
  }

  health(): PluginHealth {
    return {
      ok: true,
      status: "functional",
      details: { providerPlugins: this.providers.pluginDescriptors().length },
    };
  }
}

export const modelRouterPlugin: PluginDescriptor<
  Record<string, never>,
  ModelRouterPluginRuntime
> = {
  manifest: pluginManifest({
    id: "model-router.provider-registry",
    displayName: "Model Router",
    version: "1.0.0",
    capabilities: ["model-router", "ai-provider"],
    runtimeStatus: "functional",
    description:
      "Configured model resolution and completion routing through provider Plug-ins.",
    configKey: "model_router",
    requiredConfig: [],
    secretFields: ["provider_credentials"],
    permissions: ["network", "secrets"],
    platform: ["any"],
  }),

  create(context: PluginContext): ModelRouterPluginRuntime {
    return new ModelRouterRuntime(
      context.getService?.<ProviderRegistry>("providerRegistry") ||
        providerRegistry,
    );
  },
};
