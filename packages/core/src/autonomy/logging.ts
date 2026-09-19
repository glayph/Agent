import { globalLogger } from "../structured-logger.js";
import type { AutonomyLogEvent } from "./types.js";

/**
 * Thin wrapper around the existing global StructuredLogger. Reused as-is
 * rather than building a second logging pipeline — `globalLogger` already
 * redacts secrets (via @miki/config's redactSecrets) before anything is
 * written out, which covers the "do not log credentials/private data"
 * requirement without any extra work here.
 */
export function logAutonomyEvent(
  event: AutonomyLogEvent,
  details?: Record<string, unknown>,
): void {
  globalLogger.info(event, details);
}
