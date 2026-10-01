import type { LLMResponse } from "@miki/config";
import {
  getDefaultModelRouter,
  type FailoverHop,
  type ModelRouter,
  type ModelRouterStats,
} from "../../llm/model-router/index.js";
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
  readonly router: ModelRouter;
  resolve(model: string): ReturnType<ProviderRegistry["resolve"]>;
  /**
   * Complete with one specific model. The model is an explicit choice, so it
   * is strict (never silently swapped) — exactly like a UI model selection.
   */
  complete(
    model: string,
    messages: MikiProviderMessage[],
    extra?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LLMResponse>;
  /** Complete on a lane/role profile, with the lane's failover chain. */
  completeOnLane(
    lane: string,
    messages: MikiProviderMessage[],
    extra?: Record<string, unknown>,
    options?: { role?: string; signal?: AbortSignal },
  ): Promise<LLMResponse>;
  recentHops(limit?: number): FailoverHop[];
  stats(): ModelRouterStats;
}

class ModelRouterRuntime implements ModelRouterPluginRuntime {
  constructor(
    readonly providers: ProviderRegistry,
    readonly router: ModelRouter,
  ) {}

  resolve(model: string): ReturnType<ProviderRegistry["resolve"]> {
    return this.providers.resolve(model);
  }

  async complete(
    model: string,
    messages: MikiProviderMessage[],
    extra?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const result = await this.router.complete({
      explicitModel: model,
      messages,
      extra,
      signal,
    });
    return result.response;
  }

  async completeOnLane(
    lane: string,
    messages: MikiProviderMessage[],
    extra?: Record<string, unknown>,
    options: { role?: string; signal?: AbortSignal } = {},
  ): Promise<LLMResponse> {
    const result = await this.router.complete({
      lane,
      role: options.role,
      messages,
      extra,
      signal: options.signal,
    });
    return result.response;
  }

  recentHops(limit?: number): FailoverHop[] {
    return this.router.recentHops(limit);
  }

  stats(): ModelRouterStats {
    return this.router.stats();
  }

  health(): PluginHealth {
    const stats = this.router.stats();
    return {
      ok: true,
      status: "functional",
      details: {
        providerPlugins: this.providers.pluginDescriptors().length,
        lanes: Object.keys(this.router.getConfig().lanes),
        calls: stats.calls,
        failovers: stats.failovers,
        failed: stats.failed,
      },
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
    version: "2.0.0",
    capabilities: ["model-router", "ai-provider"],
    runtimeStatus: "functional",
    description:
      "Lane-aware model routing with provider failover, credential rotation and strict explicit-model selection.",
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
      context.getService?.<ModelRouter>("modelRouter") ||
        getDefaultModelRouter(),
    );
  },
};
