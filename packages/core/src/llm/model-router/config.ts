import type { LaneProfile, ModelRouterConfig, RoleBinding } from "./types.js";

const MAX_ATTEMPTS_DEFAULT = 8;

export interface ModelRouterConfigInputs {
  /** `agent.model_router` block from config/agent.yaml (untrusted). */
  modelRouter?: unknown;
  /**
   * Deprecated `agent.model_routing` block (`enabled/local_model/complex_model`).
   * Only read when `model_router` is absent, so existing installs keep the
   * routing they had until their config is migrated.
   */
  legacyRouting?: unknown;
  /** The globally selected model (`settings.defaultModel`). */
  defaultModel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A model reference is a non-empty token without whitespace (`provider/model`). */
export function normalizeModelRef(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed && !/\s/.test(trimmed) ? trimmed : "";
}

function uniqueRefs(values: unknown[], exclude: string): string[] {
  const seen = new Set<string>([exclude]);
  const result: string[] = [];
  for (const value of values) {
    const ref = normalizeModelRef(value);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    result.push(ref);
  }
  return result;
}

function toList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function parseProfile(
  value: unknown,
  path: string,
  warnings: string[],
): LaneProfile | undefined {
  if (typeof value === "string") {
    const primary = normalizeModelRef(value);
    if (!primary) {
      warnings.push(`${path}: ignored (not a provider/model reference)`);
      return undefined;
    }
    return { primary, fallbacks: [] };
  }
  if (!isRecord(value)) {
    warnings.push(`${path}: ignored (expected a model or {primary, fallbacks})`);
    return undefined;
  }
  const primary = normalizeModelRef(value.primary);
  if (!primary) {
    warnings.push(`${path}.primary: missing or invalid — profile ignored`);
    return undefined;
  }
  return { primary, fallbacks: uniqueRefs(toList(value.fallbacks), primary) };
}

function parseModelRouterBlock(
  block: Record<string, unknown>,
  warnings: string[],
): Omit<ModelRouterConfig, "origin" | "warnings"> {
  const lanes: Record<string, LaneProfile> = {};
  if (isRecord(block.lanes)) {
    for (const [rawName, raw] of Object.entries(block.lanes)) {
      const name = rawName.trim().toLowerCase();
      if (!name) continue;
      const profile = parseProfile(raw, `model_router.lanes.${rawName}`, warnings);
      if (profile) lanes[name] = profile;
    }
  } else if (block.lanes !== undefined) {
    warnings.push("model_router.lanes: ignored (expected a mapping)");
  }

  const roles: Record<string, RoleBinding> = {};
  if (isRecord(block.roles)) {
    for (const [rawId, raw] of Object.entries(block.roles)) {
      const id = rawId.trim().toLowerCase();
      if (!id) continue;
      if (typeof raw === "string" && !normalizeModelRef(raw).includes("/")) {
        // A bare word is a lane name.
        roles[id] = raw.trim().toLowerCase();
        continue;
      }
      const profile = parseProfile(raw, `model_router.roles.${rawId}`, warnings);
      if (profile) roles[id] = profile;
    }
  }

  const credentialProfiles: Record<string, string[]> = {};
  const rawCreds = block.credential_profiles ?? block.credentialProfiles;
  if (isRecord(rawCreds)) {
    for (const [provider, names] of Object.entries(rawCreds)) {
      const list = toList(names)
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(item));
      if (list.length > 0) {
        credentialProfiles[provider.trim().toLowerCase()] = [...new Set(list)];
      }
    }
  }

  const rawMax = Number(block.max_attempts ?? block.maxAttempts);
  const maxAttempts = Number.isFinite(rawMax)
    ? Math.min(20, Math.max(1, Math.floor(rawMax)))
    : MAX_ATTEMPTS_DEFAULT;

  return {
    enabled: block.enabled !== false,
    lanes,
    roles,
    credentialProfiles,
    maxAttempts,
  };
}

/** Rebuild the pre-router `local_model` / `complex_model` behaviour as lanes. */
function lanesFromLegacy(
  legacy: Record<string, unknown>,
  defaultModel: string,
): { enabled: boolean; lanes: Record<string, LaneProfile> } {
  const local = normalizeModelRef(legacy.local_model);
  const complex = normalizeModelRef(legacy.complex_model);
  if (legacy.enabled === false) {
    return {
      enabled: true,
      lanes: {
        default: { primary: defaultModel, fallbacks: [] },
      },
    };
  }
  const simplePrimary = local || complex || defaultModel;
  const complexPrimary = complex || local || defaultModel;
  return {
    enabled: true,
    lanes: {
      default: {
        primary: simplePrimary,
        fallbacks: uniqueRefs([complex, defaultModel], simplePrimary),
      },
      complex: {
        primary: complexPrimary,
        fallbacks: uniqueRefs([local, defaultModel], complexPrimary),
      },
    },
  };
}

/**
 * Resolve router configuration. Never throws: a garbled block yields warnings
 * and safe defaults so a bad config can never take the agent down.
 */
export function resolveModelRouterConfig(
  inputs: ModelRouterConfigInputs,
): ModelRouterConfig {
  const warnings: string[] = [];
  const defaultModel = normalizeModelRef(inputs.defaultModel);
  let origin: ModelRouterConfig["origin"] = "builtin";
  let base: Omit<ModelRouterConfig, "origin" | "warnings"> = {
    enabled: true,
    lanes: {},
    roles: {},
    credentialProfiles: {},
    maxAttempts: MAX_ATTEMPTS_DEFAULT,
  };

  if (isRecord(inputs.modelRouter)) {
    origin = "model_router";
    base = parseModelRouterBlock(inputs.modelRouter, warnings);
  } else if (inputs.modelRouter !== undefined && inputs.modelRouter !== null) {
    warnings.push("model_router: ignored (expected a mapping)");
  }

  if (origin === "builtin" && isRecord(inputs.legacyRouting)) {
    origin = "legacy_model_routing";
    warnings.push(
      "agent.model_routing is deprecated; replace it with agent.model_router.lanes (see docs/model-router.md).",
    );
    const legacy = lanesFromLegacy(inputs.legacyRouting, defaultModel);
    base = { ...base, enabled: legacy.enabled, lanes: legacy.lanes };
  }

  const lanes = { ...base.lanes };
  if (!lanes.default) lanes.default = { primary: defaultModel, fallbacks: [] };
  // Background housekeeping (memory summaries) historically ran on the
  // globally selected model, never on the local runtime; keep that unless a
  // `background` lane is configured.
  if (!lanes.background) {
    lanes.background = { primary: defaultModel, fallbacks: [] };
  }

  for (const [role, binding] of Object.entries(base.roles)) {
    if (typeof binding === "string" && !lanes[binding]) {
      warnings.push(
        `model_router.roles.${role}: lane "${binding}" is not defined; the default lane will be used`,
      );
    }
  }

  return { ...base, lanes, origin, warnings };
}
