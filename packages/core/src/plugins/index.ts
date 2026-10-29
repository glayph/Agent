export * from "./sdk/index.js";
export {
  builtinCapabilityRegistry,
  builtinPluginCatalog,
  getBuiltinPluginManifest,
  listBuiltinPluginHealth,
  listBuiltinPluginManifests,
  staticHealth,
} from "./builtin-plugin-catalog.js";
export type {
  BuiltinPluginEntry,
  BuiltinPluginFamily,
} from "./builtin-plugin-catalog.js";
export { buildPluginMarketplaceReadinessReport } from "./plugin-marketplace-readiness.js";
export type {
  BuildPluginMarketplaceReadinessOptions,
  PluginMarketplaceReadinessResult,
  PluginMarketplaceReadinessReport,
} from "./plugin-marketplace-readiness.js";

export { BrowserTool, normalizeBrowserUrl } from "./browser/runtime.js";
export type { BrowserConfig, BrowserSemanticTarget } from "./browser/runtime.js";
export { ComputerAgent } from "./computer-use/runtime.js";

// llama.cpp runtime lifecycle (single owner of the local server). The gateway calls these after model changes and at startup.
export {
  configureLocalModels,
  ensureLocalRuntime,
  getLocalRuntimeHealth,
  stopLocalRuntime,
  synchronizeLocalRuntimeForModel,
} from "./providers/llama-cpp/runtime/local-runtime.js";
export type { LocalRuntimeTransition, LocalRuntimeHealth } from "./providers/llama-cpp/runtime/local-runtime.js";
