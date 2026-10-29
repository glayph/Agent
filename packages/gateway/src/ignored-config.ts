/**
 * Configuration keys that are accepted by the schema but are not read by any runtime code.
 * Logged once at startup so a value written in agent.yaml is never silently assumed to be in effect.
 */
const IGNORED_KEY_PATHS: ReadonlyArray<string> = [
  "concurrency.toolLockTimeoutMs",
  "concurrency.taskQueueSize",
  "concurrency.schedulerIntervalMs",
  "concurrency.maxScheduledTaskAttempts",
  "concurrency.retryBaseDelayMs",
  "concurrency.retryMaxDelayMs",
  "concurrency.recoveryStaleAfterMs",
  "agent.model_router.lanes.default.primary",
  "agent.model_router.lanes.complex",
  "agent.model_router.lanes.subagent",
  "agent.model_router.lanes.heartbeat.fallbacks",
  "autonomy.tool_policy.max_retries",
]

function readPath(root: unknown, dotted: string): unknown {
  let current: unknown = root
  for (const part of dotted.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** Returns the ignored key paths that are actually present in the given config. */
export function findIgnoredConfigKeys(config: unknown): string[] {
  return IGNORED_KEY_PATHS.filter((path) => readPath(config, path) !== undefined)
}

/** Model name of the heartbeat lane, or undefined when the router is off or no lane primary is set. */
export function heartbeatLaneModel(config: unknown): string | undefined {
  if (readPath(config, "agent.model_router.enabled") === false) return undefined
  const primary = readPath(config, "agent.model_router.lanes.heartbeat.primary")
  return typeof primary === "string" && primary.trim() ? primary.trim() : undefined
}
