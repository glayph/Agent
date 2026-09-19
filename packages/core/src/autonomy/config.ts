import type { AutonomyMode } from "./types.js";

export interface AutonomySubsystemToggle {
  enabled: boolean;
}

/** Owner-requested (spec follow-up): let the controller move itself between
 * standard and turbo based on workload, with no chat command needed. Only
 * ever triggers on a concrete signal (backlog size for escalation, backlog
 * cleared + minimum time-in-mode for de-escalation) — never on a timer and
 * never while a real user interaction is in progress (autonomy-controller.ts
 * only evaluates this during the same idle window it already uses for
 * everything else). De-escalation only ever reverses a switch this same
 * mechanism made — an operator-set turbo mode (via chat command or
 * `mode: turbo` in this file) is left alone. */
export interface AutoModeSwitchConfig {
  enabled: boolean;
  /** Minimum unfinished autonomous objectives before switching standard -> turbo. */
  escalate_unfinished_objectives_at_least: number;
  /** Minimum idle minutes (same signal as the rest of tick()) before escalating. */
  escalate_idle_mins_at_least: number;
  /** Minimum minutes spent in an auto-escalated turbo mode, with the backlog
   * already back to zero, before reverting to standard. */
  de_escalate_idle_mins_in_turbo: number;
}

export interface AutonomyConfig {
  enabled: boolean;
  mode: AutonomyMode;
  planning: AutonomySubsystemToggle;
  background_tasks: AutonomySubsystemToggle;
  memory_maintenance: AutonomySubsystemToggle;
  research: AutonomySubsystemToggle;
  project_maintenance: AutonomySubsystemToggle;
  self_evaluation: AutonomySubsystemToggle;
  auto_mode_switch: AutoModeSwitchConfig;
}

export const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  enabled: true,
  mode: "standard",
  planning: { enabled: true },
  background_tasks: { enabled: true },
  memory_maintenance: { enabled: true },
  research: { enabled: true },
  project_maintenance: { enabled: true },
  self_evaluation: { enabled: true },
  auto_mode_switch: {
    enabled: true,
    escalate_unfinished_objectives_at_least: 3,
    escalate_idle_mins_at_least: 15,
    de_escalate_idle_mins_in_turbo: 30,
  },
};

function toggle(
  raw: unknown,
  fallback: AutonomySubsystemToggle,
): AutonomySubsystemToggle {
  if (raw && typeof raw === "object" && "enabled" in (raw as object)) {
    const enabled = (raw as { enabled?: unknown }).enabled;
    return {
      enabled: typeof enabled === "boolean" ? enabled : fallback.enabled,
    };
  }
  return fallback;
}

function positiveNumber(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? raw
    : fallback;
}

function parseAutoModeSwitch(
  raw: unknown,
  fallback: AutoModeSwitchConfig,
): AutoModeSwitchConfig {
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : fallback.enabled,
    escalate_unfinished_objectives_at_least: positiveNumber(
      r.escalate_unfinished_objectives_at_least,
      fallback.escalate_unfinished_objectives_at_least,
    ),
    escalate_idle_mins_at_least: positiveNumber(
      r.escalate_idle_mins_at_least,
      fallback.escalate_idle_mins_at_least,
    ),
    de_escalate_idle_mins_in_turbo: positiveNumber(
      r.de_escalate_idle_mins_in_turbo,
      fallback.de_escalate_idle_mins_in_turbo,
    ),
  };
}

/**
 * Parses the new `autonomy:` config block (section 18 of the spec). If it
 * is absent, falls back to the legacy `heartbeat.auto_actions.enabled`
 * boolean for the on/off switch only — the old `max_actions_per_cycle`
 * counter is deliberately never consulted here, since a fixed action-count
 * ceiling is exactly what section 2 asks to remove. Existing configs that
 * only set the legacy flag keep working; nothing needs to change on disk
 * for autonomy to come alive with sane defaults.
 */
export function parseAutonomyConfig(
  raw: unknown,
  legacyHeartbeatAutoActions?: unknown,
): AutonomyConfig {
  const legacyEnabled =
    legacyHeartbeatAutoActions &&
    typeof legacyHeartbeatAutoActions === "object" &&
    typeof (legacyHeartbeatAutoActions as { enabled?: unknown }).enabled ===
      "boolean"
      ? (legacyHeartbeatAutoActions as { enabled: boolean }).enabled
      : undefined;

  if (!raw || typeof raw !== "object") {
    return {
      ...DEFAULT_AUTONOMY_CONFIG,
      enabled: legacyEnabled ?? DEFAULT_AUTONOMY_CONFIG.enabled,
    };
  }

  const r = raw as Record<string, unknown>;
  const mode = r.mode === "turbo" ? "turbo" : "standard";
  return {
    enabled:
      typeof r.enabled === "boolean"
        ? r.enabled
        : (legacyEnabled ?? DEFAULT_AUTONOMY_CONFIG.enabled),
    mode,
    planning: toggle(r.planning, DEFAULT_AUTONOMY_CONFIG.planning),
    background_tasks: toggle(
      r.background_tasks,
      DEFAULT_AUTONOMY_CONFIG.background_tasks,
    ),
    memory_maintenance: toggle(
      r.memory_maintenance,
      DEFAULT_AUTONOMY_CONFIG.memory_maintenance,
    ),
    research: toggle(r.research, DEFAULT_AUTONOMY_CONFIG.research),
    project_maintenance: toggle(
      r.project_maintenance,
      DEFAULT_AUTONOMY_CONFIG.project_maintenance,
    ),
    self_evaluation: toggle(
      r.self_evaluation,
      DEFAULT_AUTONOMY_CONFIG.self_evaluation,
    ),
    auto_mode_switch: parseAutoModeSwitch(
      r.auto_mode_switch,
      DEFAULT_AUTONOMY_CONFIG.auto_mode_switch,
    ),
  };
}
