import type { AgentOrchestrator } from "../agent.js";

/**
 * Config for the "Adaptive Multi-Message Output System" (owner spec). Lives
 * at `agents.defaults.messaging` -- next to the two settings it unifies and
 * extends (`agents.defaults.split_on_marker` = Chatty Mode, and
 * `agents.defaults.tool_feedback` = the Web UI's tool-call chat messages) --
 * rather than as a new unrelated top-level key, so one place in
 * `config/agent.yaml` governs "how many/which messages does a turn send"
 * for every channel (Telegram, Discord, Slack, ..., and the Web UI).
 *
 * `enableChunking`/`avoidUnnecessaryMessages` extend
 * `splitOutboundMessageForOrchestrator` (agent-response.ts); the two
 * `minMs*` fields and `enableProgressMessages`/`maxMessagesPerResponse`
 * gate the new progress-message support in `streamAgentResponse` /
 * `collectAgentResponse` in the same file.
 */
export interface MessagingConfig {
  /** Master switch. Off means: exactly today's pre-existing behavior --
   * no progress messages, and chunking only if the older
   * `split_on_marker` flag is separately on. */
  adaptive: boolean;
  /** Cap on *extra* progress/status messages per turn (does not count the
   * final answer itself, which chunking may still split further). */
  maxMessagesPerResponse: number;
  enableChunking: boolean;
  enableStreaming: boolean;
  enableProgressMessages: boolean;
  /** Soft cap on chunk size, applied on top of (never above) whatever hard
   * platform limit the channel itself passes in. 0 = no extra clamp. */
  maxChunkLength: number;
  /** Reserved for future stricter anti-spam tuning; currently expressed via
   * splitForChattyMode's own short-fragment merge-back and the two minMs*
   * gates below rather than a separate knob. */
  avoidUnnecessaryMessages: boolean;
  /** A turn must run at least this long before its first progress message
   * fires, so ordinary fast replies stay exactly one message. */
  minMsBeforeFirstProgress: number;
  /** Minimum gap between two progress messages in the same turn. */
  minMsBetweenProgress: number;
}

export const DEFAULT_MESSAGING_CONFIG: MessagingConfig = {
  adaptive: true,
  maxMessagesPerResponse: 3,
  enableChunking: true,
  enableStreaming: true,
  enableProgressMessages: true,
  maxChunkLength: 0,
  avoidUnnecessaryMessages: true,
  minMsBeforeFirstProgress: 4000,
  minMsBetweenProgress: 2500,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function nonNegativeNumber(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? raw
    : fallback;
}

export function parseMessagingConfig(raw: unknown): MessagingConfig {
  if (!isRecord(raw)) return DEFAULT_MESSAGING_CONFIG;
  return {
    adaptive: bool(raw.adaptive, DEFAULT_MESSAGING_CONFIG.adaptive),
    maxMessagesPerResponse: nonNegativeNumber(
      raw.max_messages_per_response,
      DEFAULT_MESSAGING_CONFIG.maxMessagesPerResponse,
    ),
    enableChunking: bool(
      raw.enable_chunking,
      DEFAULT_MESSAGING_CONFIG.enableChunking,
    ),
    enableStreaming: bool(
      raw.enable_streaming,
      DEFAULT_MESSAGING_CONFIG.enableStreaming,
    ),
    enableProgressMessages: bool(
      raw.enable_progress_messages,
      DEFAULT_MESSAGING_CONFIG.enableProgressMessages,
    ),
    maxChunkLength: nonNegativeNumber(
      raw.max_chunk_length,
      DEFAULT_MESSAGING_CONFIG.maxChunkLength,
    ),
    avoidUnnecessaryMessages: bool(
      raw.avoid_unnecessary_messages,
      DEFAULT_MESSAGING_CONFIG.avoidUnnecessaryMessages,
    ),
    minMsBeforeFirstProgress: nonNegativeNumber(
      raw.min_ms_before_first_progress,
      DEFAULT_MESSAGING_CONFIG.minMsBeforeFirstProgress,
    ),
    minMsBetweenProgress: nonNegativeNumber(
      raw.min_ms_between_progress,
      DEFAULT_MESSAGING_CONFIG.minMsBetweenProgress,
    ),
  };
}

/** Reads `agents.defaults.messaging` off a live orchestrator's config,
 * falling back to defaults for anything absent or malformed. Never throws --
 * every read site in agent-response.ts calls this on every turn, so a bad
 * config shape must degrade to defaults, not break message delivery. */
export function getMessagingConfig(
  orchestrator: Pick<AgentOrchestrator, "config">,
): MessagingConfig {
  try {
    const config = orchestrator?.config;
    const agents = isRecord(config) && isRecord(config.agents)
      ? config.agents
      : {};
    const defaults = isRecord(agents.defaults) ? agents.defaults : {};
    return parseMessagingConfig(defaults.messaging);
  } catch {
    return DEFAULT_MESSAGING_CONFIG;
  }
}
