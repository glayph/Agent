import type { CommandQueueConfig, QueueMode } from "./types.js";
import { QUEUE_MODES } from "./types.js";

export function isQueueMode(value: unknown): value is QueueMode {
  return typeof value === "string" && (QUEUE_MODES as readonly string[]).includes(value);
}

/**
 * Resolve queue mode by priority:
 * inline/session override → per-surface config → global default → built-in steer.
 */
export function resolveQueueMode(
  config: CommandQueueConfig,
  options: { session_key: string; surface?: string; inlineMode?: QueueMode },
): QueueMode {
  if (options.inlineMode && isQueueMode(options.inlineMode)) {
    return options.inlineMode;
  }
  const sessionMode = config.sessionModes?.[options.session_key];
  if (sessionMode && isQueueMode(sessionMode)) {
    return sessionMode;
  }
  if (options.surface) {
    const surfaceMode = config.surfaceModes?.[options.surface];
    if (surfaceMode && isQueueMode(surfaceMode)) {
      return surfaceMode;
    }
  }
  if (isQueueMode(config.defaultMode)) {
    return config.defaultMode;
  }
  return "steer";
}
