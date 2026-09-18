import type { AutonomyMode } from "./types.js";

export interface AutonomySubsystemToggle {
  enabled: boolean;
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
}

export const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  enabled: true,
  mode: "turbo",
  planning: { enabled: true },
  background_tasks: { enabled: true },
  memory_maintenance: { enabled: true },
  research: { enabled: true },
  project_maintenance: { enabled: true },
  self_evaluation: { enabled: true },
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
  // Standard mode has been removed — turbo is the only valid value now,
  // regardless of what an old on-disk config's `mode:` field says.
  const mode: AutonomyMode = "turbo";
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
  };
}
