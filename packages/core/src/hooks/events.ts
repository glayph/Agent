/**
 * Step 11 — Canonical lifecycle event names.
 * Additive only: cores emit these; plugins/operators subscribe.
 */

export const LIFECYCLE_EVENTS = [
  // Session
  "session:start",
  "session:end",
  "session:reset",
  "session:compact:before",
  "session:compact:after",
  // Workspace / process
  "workspace:bootstrap",
  "gateway:startup",
  "gateway:shutdown",
  // Messages (after Step 06 normalize)
  "message:received",
  "message:sent",
  // Tools (Step 04 gate seam)
  "tool:before_call",
  "tool:after_call",
  // Subagents (Step 10)
  "subagent:spawned",
  "subagent:ended",
  // Command / control
  "command:new",
  "command:reset",
  "command:stop",
] as const;

export type LifecycleEventName = (typeof LIFECYCLE_EVENTS)[number];

export interface SessionEventPayload {
  session_key: string;
  surface?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface CompactEventPayload {
  session_key?: string;
  beforeTokens?: number;
  afterTokens?: number;
  [key: string]: unknown;
}

export interface MessageEventPayload {
  session_key?: string;
  surface?: string;
  eventId?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolEventPayload {
  toolName: string;
  args?: unknown;
  session_key?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
  [key: string]: unknown;
}

/** Handlers may return this from emitAsync for tool:before_call to block. */
export interface HookControlResult {
  /** When true, the emitter should abort the operation. */
  block?: boolean;
  reason?: string;
}

export interface SubagentEventPayload {
  agentId: string;
  parentSessionKey?: string;
  role?: string;
  [key: string]: unknown;
}

export interface GatewayEventPayload {
  pid?: number;
  reason?: string;
  [key: string]: unknown;
}

export type LifecyclePayloadMap = {
  "session:start": SessionEventPayload;
  "session:end": SessionEventPayload;
  "session:reset": SessionEventPayload;
  "session:compact:before": CompactEventPayload;
  "session:compact:after": CompactEventPayload;
  "workspace:bootstrap": Record<string, unknown>;
  "gateway:startup": GatewayEventPayload;
  "gateway:shutdown": GatewayEventPayload;
  "message:received": MessageEventPayload;
  "message:sent": MessageEventPayload;
  "tool:before_call": ToolEventPayload;
  "tool:after_call": ToolEventPayload;
  "subagent:spawned": SubagentEventPayload;
  "subagent:ended": SubagentEventPayload;
  "command:new": Record<string, unknown>;
  "command:reset": Record<string, unknown>;
  "command:stop": Record<string, unknown>;
};
