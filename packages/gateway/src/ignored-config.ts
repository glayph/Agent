/** Configuration keys accepted by the schema but not consumed by runtime code. */
import { resolveModelRouterConfig } from "@miki/core/llm/model-router";

const IGNORED_KEY_PATHS: ReadonlyArray<string> = [
  "concurrency.schedulerIntervalMs",
  "concurrency.recoveryStaleAfterMs",
  "autonomy.tool_policy.max_retries",
];

function readPath(root: unknown, dotted: string): unknown {
  let current: unknown = root;
  for (const part of dotted.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Returns only config paths which are genuinely present and currently unused. */
export function findIgnoredConfigKeys(config: unknown): string[] {
  return IGNORED_KEY_PATHS.filter((path) => readPath(config, path) !== undefined);
}

/** Model name of the enabled heartbeat lane, if it resolves to a valid primary. */
export function heartbeatLaneModel(config: unknown): string | undefined {
  const root = config && typeof config === "object" ? config as Record<string, unknown> : {};
  const agent = root.agent && typeof root.agent === "object" ? root.agent as Record<string, unknown> : {};
  const router = resolveModelRouterConfig(agent.model_router);
  if (!router.enabled) return undefined;
  const heartbeat = router.lanes.heartbeat;
  return heartbeat?.primary;
}
