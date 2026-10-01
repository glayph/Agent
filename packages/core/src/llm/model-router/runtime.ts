import { settings } from "@miki/config";
import { providerRegistry } from "../provider/registry.js";
import {
  isLocalModel,
  synchronizeLocalRuntimeForModel,
} from "../../plugins/providers/llama-cpp/runtime/local-runtime.js";
import {
  resolveModelRouterConfig,
  type ModelRouterConfigInputs,
} from "./config.js";
import { ModelRouter, type ModelRouterOptions } from "./router.js";

/**
 * Start/sync the managed local runtime before a local model is probed or used
 * as a failover target. Remote models need no preparation.
 */
export async function prepareModelForRouting(model: string): Promise<void> {
  if (isLocalModel(model)) await synchronizeLocalRuntimeForModel(model);
}

/** Build a router wired to the process-wide provider registry. */
export function createModelRouter(
  inputs: ModelRouterConfigInputs,
  overrides: Partial<Omit<ModelRouterOptions, "config">> = {},
): ModelRouter {
  return new ModelRouter({
    providers: providerRegistry,
    prepare: prepareModelForRouting,
    ...overrides,
    config: resolveModelRouterConfig(inputs),
  });
}

let defaultRouter: ModelRouter | undefined;
let configuredInputs: ModelRouterConfigInputs | undefined;
let builtinModelSeen = "";

/**
 * Process-wide router used by callers that have no orchestrator of their own
 * (`achatCompletion`, plugins). Until `configureDefaultModelRouter()` supplies
 * the loaded agent config it follows the globally selected model.
 */
export function getDefaultModelRouter(): ModelRouter {
  const current = String(settings.defaultModel ?? "");
  if (!defaultRouter) {
    defaultRouter = createModelRouter(
      configuredInputs ?? { defaultModel: current },
    );
    builtinModelSeen = current;
  } else if (!configuredInputs && builtinModelSeen && builtinModelSeen !== current) {
    defaultRouter.updateConfig(resolveModelRouterConfig({ defaultModel: current }));
    builtinModelSeen = current;
  }
  return defaultRouter;
}

export function configureDefaultModelRouter(
  inputs: ModelRouterConfigInputs,
): ModelRouter {
  configuredInputs = inputs;
  const router = getDefaultModelRouter();
  router.updateConfig(resolveModelRouterConfig(inputs));
  return router;
}

/**
 * Adopt an orchestrator's router as the process-wide one, so non-orchestrator
 * callers (`achatCompletion`, plugins) share its config, stats and hop log.
 */
export function setDefaultModelRouter(router: ModelRouter): void {
  defaultRouter = router;
  configuredInputs = undefined;
  builtinModelSeen = "";
}
