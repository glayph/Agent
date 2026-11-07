/**
 * Pure, defensive parser for agent.model_router.
 *
 * The runtime config schema intentionally accepts this subtree shallowly so a
 * malformed optional route cannot invalidate the rest of agent.yaml. This
 * module is the single runtime contract for lane, role and credential routing.
 */

export interface ModelRoute {
  primary?: string;
  fallbacks: string[];
}

export interface ModelRouterConfig {
  enabled: boolean;
  /** @deprecated Kept for config/API compatibility. Explicit fallback routes are never truncated. */
  maxAttempts: number;
  lanes: Record<string, ModelRoute>;
  roles: Record<string, string | ModelRoute>;
  credentialProfiles: Record<string, string[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function cleanModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned.length > 0 && cleaned.length <= 256 ? cleaned : undefined;
}

function cleanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const name = cleanModel(item);
    if (name && !result.includes(name)) result.push(name);
  }
  return result;
}

function parseRoute(value: unknown): ModelRoute | undefined {
  if (typeof value === "string") {
    const primary = cleanModel(value);
    return primary ? { primary, fallbacks: [] } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const primary = cleanModel(value.primary);
  const fallbacks = cleanNames(value.fallbacks);
  if (!primary && fallbacks.length === 0) return undefined;
  return {
    ...(primary ? { primary } : {}),
    fallbacks: fallbacks.filter((item) => item !== primary),
  };
}

/** Parse the optional config without mutating caller data or exposing secrets. */
export function resolveModelRouterConfig(value: unknown): ModelRouterConfig {
  const raw = isRecord(value) ? value : {};
  const rawLanes = isRecord(raw.lanes) ? raw.lanes : {};
  const rawRoles = isRecord(raw.roles) ? raw.roles : {};
  const rawProfiles = isRecord(raw.credential_profiles) ? raw.credential_profiles : {};
  const lanes: Record<string, ModelRoute> = {};
  const roles: Record<string, string | ModelRoute> = {};
  const credentialProfiles: Record<string, string[]> = {};

  for (const [name, routeValue] of Object.entries(rawLanes)) {
    if (!/^[a-z0-9_.-]{1,64}$/i.test(name)) continue;
    const route = parseRoute(routeValue);
    if (route) lanes[name] = route;
  }
  for (const [name, roleValue] of Object.entries(rawRoles)) {
    if (!/^[a-z0-9_.-]{1,96}$/i.test(name)) continue;
    if (typeof roleValue === "string") {
      const lane = roleValue.trim();
      if (lane && lane.length <= 64) roles[name] = lane;
      continue;
    }
    const route = parseRoute(roleValue);
    if (route) roles[name] = route;
  }
  for (const [providerId, names] of Object.entries(rawProfiles)) {
    if (!/^[a-z0-9_.-]{1,64}$/i.test(providerId)) continue;
    const profiles = cleanNames(names).filter((name) => /^[A-Z][A-Z0-9_]{1,127}$/.test(name));
    if (profiles.length) credentialProfiles[providerId.toLowerCase()] = profiles;
  }

  // `max_attempts` was historically used to truncate configured model and credential
  // fallbacks. Keep the parsed contract property for older callers, but treat it as
  // unbounded: an explicit, owner-configured route is the complete fallback chain.
  // Provider errors are still classified, rate-limited, and circuit-broken elsewhere.
  return {
    enabled: raw.enabled !== false,
    maxAttempts: Number.POSITIVE_INFINITY,
    lanes,
    roles,
    credentialProfiles,
  };
}

/** A role may point to a named lane or provide a direct model route. */
export function resolveRoleModelRoute(
  config: ModelRouterConfig,
  roleId?: string,
): { laneName: string; route: ModelRoute } | undefined {
  if (!config.enabled) return undefined;
  const role = roleId ? config.roles[roleId] : undefined;
  if (typeof role === "string") {
    const route = config.lanes[role];
    return route ? { laneName: role, route } : undefined;
  }
  if (role) return { laneName: `role:${roleId}`, route: role };
  const route = config.lanes.default;
  return route ? { laneName: "default", route } : undefined;
}

/** Resolve the route associated with a model, preferring the active agent role. */
export function resolveModelRouteForModel(
  config: ModelRouterConfig,
  model: string,
  preferredRoleId?: string,
): { laneName: string; route: ModelRoute } | undefined {
  if (!config.enabled) return undefined;
  const preferred = resolveRoleModelRoute(config, preferredRoleId);
  if (preferred?.route.primary === model) return preferred;
  for (const [laneName, route] of Object.entries(config.lanes)) {
    if (route.primary === model) return { laneName, route };
  }
  for (const roleId of Object.keys(config.roles)) {
    const roleRoute = resolveRoleModelRoute(config, roleId);
    if (roleRoute?.route.primary === model) return roleRoute;
  }
  return undefined;
}

/**
 * Returns only alternate route candidates. Authentication profiles are kept
 * separate from model names so callers can retry a rejected key without
 * switching model or leaking key values into logs.
 */
export function buildModelFallbacks(input: {
  primaryModel?: string;
  route?: ModelRoute;
  legacyFallbacks?: string[];
  /** @deprecated Ignored. Explicit fallback lists are not capped by a retry counter. */
  maxAttempts?: number;
}): string[] {
  const primary = cleanModel(input.primaryModel);
  const ordered = [
    ...(input.route?.fallbacks ?? []),
    ...(input.legacyFallbacks ?? []),
  ].map(cleanModel).filter((item): item is string => Boolean(item));
  const unique = ordered.filter((model, index) =>
    model !== primary && ordered.indexOf(model) === index,
  );
  return unique;
}
