import { redactSecrets } from "@hiro/config";

export interface SessionPermissionDecision {
  toolName: string;
  enabled: boolean;
  reason: string;
  decidedAt: string;
  source: "default" | "session";
}

export interface SessionPermissionDenialEntry {
  toolName: string;
  reason: string;
  deniedAt: string;
  actor: "api" | "mcp" | "system";
  source: "default" | "session";
  requestId?: string;
  argsPreview?: Record<string, unknown>;
}

export interface SessionPermissionTimelineEntry {
  toolName: string;
  enabled: boolean;
  reason: string;
  changedAt: string;
  actor: "api" | "system";
  action?: "grant" | "deny" | "revoke" | "policy_change";
}

export interface SessionPermissionState {
  sessionId: string;
  permissions: Record<string, boolean>;
  timeline: SessionPermissionTimelineEntry[];
  denials: SessionPermissionDenialEntry[];
}

const sessionPermissionStates = new Map<string, SessionPermissionState>();
const SAFE_TOOL_PERMISSION_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_TIMELINE_ENTRIES = 500;
const MAX_DENIAL_ENTRIES = 500;
const MAX_ARGS_PREVIEW_BYTES = 4096;

export function getSessionPermissions(
  sessionId: string,
): Record<string, boolean> {
  return { ...getOrCreateState(sessionId).permissions };
}

export function getSessionPermissionState(
  sessionId: string,
): SessionPermissionState {
  const state = getOrCreateState(sessionId);
  return {
    sessionId: state.sessionId,
    permissions: { ...state.permissions },
    timeline: state.timeline.map((entry) => ({ ...entry })),
    denials: state.denials.map((entry) => ({
      ...entry,
      argsPreview: cloneArgsPreview(entry.argsPreview),
    })),
  };
}

export function setSessionPermissions(
  sessionId: string,
  permissions: Record<string, boolean>,
): void {
  const state = getOrCreateState(sessionId);
  const nextPermissions = sanitizePermissions(permissions);
  const now = new Date().toISOString();
  const toolNames = new Set([
    ...Object.keys(state.permissions),
    ...Object.keys(nextPermissions),
  ]);
  for (const toolName of toolNames) {
    const previous = state.permissions[toolName];
    const next = nextPermissions[toolName];
    if (previous === next) continue;
    if (next === undefined) {
      state.timeline.push({
        toolName,
        enabled: true,
        reason: "Session-specific permission removed; default policy applies.",
        changedAt: now,
        actor: "api",
        action: "revoke",
      });
      continue;
    }
    state.timeline.push({
      toolName,
      enabled: next,
      reason: next
        ? "Tool allowed for this session."
        : "Tool denied for this session.",
      changedAt: now,
      actor: "api",
      action: next ? "grant" : "deny",
    });
  }
  state.permissions = nextPermissions;
  state.timeline = state.timeline.slice(-MAX_TIMELINE_ENTRIES);
  sessionPermissionStates.set(state.sessionId, state);
}

export function getToolPermissionDecision(
  sessionId: string,
  toolName: string,
): SessionPermissionDecision {
  const normalizedToolName = normalizeToolName(toolName);
  const state = getOrCreateState(sessionId);
  const explicit = state.permissions[normalizedToolName];
  const enabled = explicit !== false;
  return {
    toolName: normalizedToolName,
    enabled,
    reason: enabled
      ? explicit === true
        ? "Tool is explicitly allowed for this session."
        : "Tool is allowed by default for this session."
      : "Tool is disabled for this session.",
    decidedAt: new Date().toISOString(),
    source: explicit === undefined ? "default" : "session",
  };
}

export function recordToolPermissionDenial(
  sessionId: string,
  decision: SessionPermissionDecision,
  options: {
    actor?: "api" | "mcp" | "system";
    requestId?: string;
    args?: Record<string, unknown>;
    deniedAt?: string;
  } = {},
): SessionPermissionDenialEntry {
  const state = getOrCreateState(sessionId);
  const entry: SessionPermissionDenialEntry = {
    toolName: normalizeToolName(decision.toolName),
    reason: String(decision.reason || "Tool denied by session policy."),
    deniedAt: normalizeIsoTimestamp(options.deniedAt),
    actor: options.actor || "api",
    source: decision.source,
    requestId: sanitizeOptionalText(options.requestId),
    argsPreview: sanitizeArgsPreview(options.args),
  };
  state.denials.push(entry);
  state.denials = state.denials.slice(-MAX_DENIAL_ENTRIES);
  sessionPermissionStates.set(state.sessionId, state);
  return {
    ...entry,
    argsPreview: cloneArgsPreview(entry.argsPreview),
  };
}

export function isToolEnabledForSession(
  sessionId: string,
  toolName: string,
): boolean {
  return getToolPermissionDecision(sessionId, toolName).enabled;
}

export function clearSessionPermissions(sessionId?: string): void {
  if (sessionId) {
    sessionPermissionStates.delete(normalizeSessionId(sessionId));
    return;
  }
  sessionPermissionStates.clear();
}

function getOrCreateState(sessionId: string): SessionPermissionState {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const existing = sessionPermissionStates.get(normalizedSessionId);
  if (existing) return existing;
  const state: SessionPermissionState = {
    sessionId: normalizedSessionId,
    permissions: {},
    timeline: [],
    denials: [],
  };
  sessionPermissionStates.set(normalizedSessionId, state);
  return state;
}

function normalizeSessionId(sessionId: string): string {
  return String(sessionId || "").trim();
}

function normalizeToolName(toolName: string): string {
  const normalizedName = String(toolName || "").trim();
  return SAFE_TOOL_PERMISSION_NAME.test(normalizedName) &&
    !hasUnsafeObjectKeySegment(normalizedName)
    ? normalizedName
    : "unknown";
}

function sanitizePermissions(
  permissions: Record<string, unknown>,
): Record<string, boolean> {
  const sanitized: Record<string, boolean> = {};
  for (const [toolName, enabled] of Object.entries(permissions)) {
    const normalizedName = normalizeToolName(toolName);
    if (normalizedName === "unknown") continue;
    if (typeof enabled !== "boolean") continue;
    sanitized[normalizedName] = enabled;
  }
  return sanitized;
}

function sanitizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = redactSecrets(value.trim()).slice(0, 256);
  return sanitized || undefined;
}

function sanitizeArgsPreview(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const redacted = redactSecrets(args);
  const json = JSON.stringify(redacted);
  if (json.length <= MAX_ARGS_PREVIEW_BYTES) return redacted;
  return {
    truncated: true,
    originalBytes: json.length,
    preview: redactSecrets(json.slice(0, MAX_ARGS_PREVIEW_BYTES)),
  };
}

function cloneArgsPreview(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!args) return undefined;
  return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
}

function normalizeIsoTimestamp(value: unknown): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function hasUnsafeObjectKeySegment(toolName: string): boolean {
  return toolName
    .split(/[.:-]/)
    .some((part) => ["__proto__", "prototype", "constructor"].includes(part));
}
