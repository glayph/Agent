import type { MemoryFilesConfig, SummarizerMode } from "./types.js";

export const DEFAULT_MEMORY_FILES_CONFIG: MemoryFilesConfig = {
  enabled: true,
  bootstrapMaxChars: 6_000,
  memoryMdMaxChars: 3_500,
  recentDays: 2,
  indexMaxEntries: 6,
  summarizer: "auto",
  summaryTimeoutMs: 25_000,
  summaryTurns: 20,
  sessionIdleMinutes: 30,
  minTurnsForSummary: 2,
  writer: { maxSlowQueue: 50 },
  compaction: {
    enabled: true,
    triggerPercent: 75,
    minMessages: 8,
    keepRecent: 6,
    maxSummaryChars: 3_000,
    flushEnabled: true,
    flushMarginPercent: 10,
  },
};

function bounded(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

type Raw = Record<string, unknown> | undefined | null;
const obj = (v: unknown): Raw =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * Resolve `agent.memory.files` from config/agent.yaml. Every knob is
 * optional and clamped; garbage values fall back to defaults instead of
 * throwing (memory config must never stop the agent from starting).
 */
export function resolveMemoryFilesConfig(
  agentMemory?: unknown,
  seed: Partial<{
    summarizeTokenPercent: number;
    summarizeMessageThreshold: number;
  }> = {},
): MemoryFilesConfig {
  const d = DEFAULT_MEMORY_FILES_CONFIG;
  const raw = obj(obj(agentMemory)?.["files"]);
  const c = obj(raw?.["compaction"]);
  const w = obj(raw?.["writer"]);
  const mode = raw?.["summarizer"];
  const summarizer: SummarizerMode =
    mode === "llm" || mode === "heuristic" || mode === "auto"
      ? mode
      : d.summarizer;
  const dir = raw?.["dir"];
  return {
    enabled: bool(raw?.["enabled"], d.enabled),
    ...(typeof dir === "string" && dir.trim() ? { dir: dir.trim() } : {}),
    ...(typeof raw?.["scope"] === "string" && (raw["scope"] as string).trim()
      ? { scope: (raw["scope"] as string).trim() }
      : {}),
    bootstrapMaxChars: bounded(
      raw?.["bootstrap_max_chars"],
      d.bootstrapMaxChars,
      500,
      50_000,
    ),
    memoryMdMaxChars: bounded(
      raw?.["memory_md_max_chars"],
      d.memoryMdMaxChars,
      200,
      40_000,
    ),
    recentDays: bounded(raw?.["recent_days"], d.recentDays, 1, 30),
    indexMaxEntries: bounded(raw?.["index_max_entries"], d.indexMaxEntries, 0, 30),
    summarizer,
    summaryTimeoutMs: bounded(
      raw?.["summary_timeout_ms"],
      d.summaryTimeoutMs,
      1_000,
      300_000,
    ),
    summaryTurns: bounded(raw?.["summary_turns"], d.summaryTurns, 2, 200),
    sessionIdleMinutes: bounded(
      raw?.["session_idle_minutes"],
      d.sessionIdleMinutes,
      0,
      10_080,
    ),
    minTurnsForSummary: bounded(
      raw?.["min_turns_for_summary"],
      d.minTurnsForSummary,
      1,
      50,
    ),
    writer: {
      maxSlowQueue: bounded(w?.["max_slow_queue"], d.writer.maxSlowQueue, 1, 1_000),
    },
    compaction: {
      enabled: bool(c?.["enabled"], d.compaction.enabled),
      triggerPercent: bounded(
        c?.["trigger_percent"],
        seed.summarizeTokenPercent ?? d.compaction.triggerPercent,
        30,
        95,
      ),
      minMessages: bounded(
        c?.["min_messages"],
        Math.min(
          d.compaction.minMessages,
          seed.summarizeMessageThreshold ?? d.compaction.minMessages,
        ),
        3,
        200,
      ),
      keepRecent: bounded(c?.["keep_recent"], d.compaction.keepRecent, 2, 100),
      maxSummaryChars: bounded(
        c?.["max_summary_chars"],
        d.compaction.maxSummaryChars,
        500,
        20_000,
      ),
      flushEnabled: bool(c?.["flush_enabled"], d.compaction.flushEnabled),
      flushMarginPercent: bounded(
        c?.["flush_margin_percent"],
        d.compaction.flushMarginPercent,
        1,
        40,
      ),
    },
  };
}
