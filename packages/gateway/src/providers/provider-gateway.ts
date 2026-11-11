import type { EngineLLMClient } from "@miki/core/engine";
import {
  createFetchLLMClient,
  createRegistryLLMClient,
  configureLocalModels as configureLocalProviderModels,
  providerRegistry,
  synchronizeLocalRuntimeForModel as synchronizeProviderRuntimeForModel,
  type LocalRuntimeTransition,
  type ProviderRegistry,
} from "@miki/core/plugins/providers";

/**
 * The single in-process boundary between the Agent runtime and model providers.
 *
 * The Agent asks this gateway for an LLM client and credential failover routes.
 * The Gateway composition root also uses it for local-provider configuration
 * and lifecycle transitions; registry details and transport selection stay here.
 */
export interface AgentProviderRoute {
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  credentialProfile?: string;
  extra?: Record<string, unknown>;
}

export type AgentProviderRouteResolver = () => AgentProviderRoute | undefined

export class ProviderGateway {
  constructor(private readonly registry: ProviderRegistry = providerRegistry) {}

  /** Configure the built-in local provider from the Gateway's persisted model catalog. */
  configureLocalModels(models: unknown[]): void {
    configureLocalProviderModels(models);
  }

  /** Serialize local-provider model lifecycle changes through the Gateway boundary. */
  synchronizeLocalRuntimeForModel(model: string): Promise<LocalRuntimeTransition> {
    return synchronizeProviderRuntimeForModel(model);
  }

  isLocalProviderId(provider: unknown): boolean {
    const normalized = String(provider ?? "").trim().toLowerCase();
    const registered = this.registry.getPluginRegistry().get(normalized);
    if (registered) return registered.manifest.capabilities.local === true;
    return normalized.includes("llama")
      || ["local", "local-llama", "llama-cpp", "llamacpp"].includes(normalized);
  }

  createAgentClient(route: AgentProviderRoute): EngineLLMClient {
    const providerPlugin = this.registry.getPluginRegistry().get(route.providerId);
    if (!providerPlugin) {
      const client = createFetchLLMClient({
        baseUrl: route.baseUrl,
        model: route.model,
        apiKey: route.apiKey || undefined,
        ...(route.extra && Object.keys(route.extra).length ? { extraBody: route.extra } : {}),
      });
      return {
        ...client,
        providerId: route.providerId,
        routeKey: [route.providerId, route.baseUrl, route.model, route.credentialProfile ?? "default"].join("|"),
        ...(route.credentialProfile ? { credentialProfile: route.credentialProfile } : {}),
      };
    }

    return createRegistryLLMClient(this.registry, route.model, {
      providerId: route.providerId,
      baseUrl: route.baseUrl,
      ...(route.credentialProfile
        ? { credentialProfile: route.credentialProfile }
        : { credentials: route.apiKey ? { apiKey: route.apiKey } : {} }),
      supportsVision: providerPlugin.manifest.capabilities.vision,
      ...(route.extra && Object.keys(route.extra).length ? { extra: route.extra } : {}),
    });
  }

  /**
   * Create a stable Agent port whose transport is re-resolved by Gateway for every
   * completion. Provider credentials, endpoint edits and model selection therefore
   * become effective without rebuilding the Agent runtime or restarting a run.
   */
  createDynamicAgentClient(resolveRoute: AgentProviderRouteResolver): EngineLLMClient {
    const initial = resolveRoute();
    if (!initial) throw new Error("Gateway could not resolve an initial model route.");
    let lastKnown = initial;
    const gateway = this;
    const current = (): AgentProviderRoute => {
      const next = resolveRoute();
      if (next) lastKnown = next;
      return lastKnown;
    };
    return {
      get model() { return current().model; },
      get providerId() { return current().providerId; },
      get credentialProfile() { return current().credentialProfile; },
      get supportsVision() {
        const route = current();
        return gateway.registry.getPluginRegistry().get(route.providerId)?.manifest.capabilities.vision;
      },
      get routeKey() {
        const route = current();
        return [route.providerId, route.baseUrl, route.model, route.credentialProfile ?? "default"].join("|");
      },
      complete(messages, options) {
        const route = resolveRoute();
        if (!route) throw new Error("Gateway has no active model route; select or configure a model to resume this Agent call.");
        lastKnown = route;
        return gateway.createAgentClient(route).complete(messages, options);
      },
    };
  }

  providerIdForModel(model: string): string | undefined {
    return this.registry.providerIdFor(model);
  }

  credentialFallbacks(
    model: string,
    configuredProfiles: string[],
  ): Array<{ model: string; credentialProfile: string }> {
    const providerId = this.registry.providerIdFor(model);
    if (!providerId) return [];

    const plugin = this.registry.getPluginRegistry().get(providerId);
    const primarySecretName = plugin?.auth.envVars?.[0];
    return this.registry.credentialProfiles(model, configuredProfiles)
      .filter((name) => Boolean(primarySecretName)
        && name !== primarySecretName
        && configuredProfiles.includes(name))
      .map((credentialProfile) => ({ model, credentialProfile }));
  }
}

export const providerGateway = new ProviderGateway();
