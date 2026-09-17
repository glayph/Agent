import {
  LocalFirstSearchRouter,
  type PageFetchResponse,
  type SearchQuery,
  type SearchResponse,
} from "./local-first-search.js";
import {
  pluginManifest,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
} from "../plugins/sdk/index.js";

export interface SearchPluginConfig {
  mode?: "local" | "cloud" | "auto";
}

export interface SearchPluginRuntime extends ManagedPlugin {
  readonly router: LocalFirstSearchRouter;
  search(input: SearchQuery): Promise<SearchResponse>;
  fetch(
    url: string,
    mode?: SearchPluginConfig["mode"],
  ): Promise<PageFetchResponse>;
}

class SearchRuntime implements SearchPluginRuntime {
  constructor(readonly router: LocalFirstSearchRouter) {}

  search(input: SearchQuery): Promise<SearchResponse> {
    return this.router.search(input);
  }

  fetch(
    url: string,
    mode?: SearchPluginConfig["mode"],
  ): Promise<PageFetchResponse> {
    return this.router.fetch(url, mode);
  }

  health(): PluginHealth {
    return { ok: true, status: "functional", details: { localFirst: true } };
  }
}

export const searchPlugin: PluginDescriptor<
  SearchPluginConfig,
  SearchPluginRuntime
> = {
  manifest: pluginManifest({
    id: "search.local-first",
    displayName: "Local-first Search",
    version: "1.0.0",
    capabilities: ["search"],
    runtimeStatus: "functional",
    description:
      "Local-first web search with an optional configured cloud fallback.",
    configKey: "search",
    requiredConfig: [],
    secretFields: ["cloud_token"],
    permissions: ["network", "secrets"],
    platform: ["any"],
  }),

  create(
    context: PluginContext,
    config: SearchPluginConfig = {},
  ): SearchPluginRuntime {
    const router = new LocalFirstSearchRouter();
    context.log("plugin.search.created", {
      mode: config.mode || router.defaultMode,
    });
    return new SearchRuntime(router);
  },
};
