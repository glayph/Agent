/**
 * Pure helpers behind the Inspector / Live Inspector event stream.
 *
 * These build the human-readable strings and truncated previews that get
 * attached to `node.spawn` / `node.complete` websocket payloads and to
 * inspector-only "thought" chat messages (see api/index.ts). They are kept
 * in their own module — with no WebSocket, session, or orchestrator
 * dependency — specifically so they can be unit tested directly. The
 * surrounding api/index.ts constructs a live AgentOrchestrator at module
 * load time, which makes importing it directly in a test heavy and
 * environment-dependent; these pure functions have no such cost.
 *
 * api/index.ts re-exports and calls these; behavior is unchanged.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function previewToolArgs(
  input: unknown,
  maxArgsLength: number,
): string {
  const full = JSON.stringify(input || {});
  if (full.length <= maxArgsLength) return full;
  return full.slice(0, maxArgsLength) + "…";
}

export function previewToolOutput(output: unknown, maxLength: number): string {
  const full =
    typeof output === "string" ? output : JSON.stringify(output ?? "");
  if (full.length <= maxLength) return full;
  return full.slice(0, maxLength) + "…";
}

export function toolPath(input: unknown): string {
  const record = asRecord(input);
  const value = typeof record.path === "string" ? record.path.trim() : "";
  return value || "the requested path";
}

export function toolActionDescription(tool: unknown, input: unknown): string {
  const name = typeof tool === "string" ? tool : "tool";
  const target = toolPath(input);
  if (name === "file_read") return `Reading file: ${target}`;
  if (name === "file_write") return `Editing file: ${target}`;
  if (name === "file_delete") {
    return asRecord(input).dryRun === true
      ? `Checking deletion without changing the file: ${target}`
      : `Deleting file: ${target}`;
  }
  return `Running tool: ${name}`;
}

export function toolResultDescription(
  tool: unknown,
  input: unknown,
  ok: boolean,
  output: unknown,
  durationMs: unknown,
  maxLength: number,
): string {
  const action = toolActionDescription(tool, input);
  const elapsed = Number(durationMs);
  const timing = Number.isFinite(elapsed)
    ? ` (${Math.max(0, Math.round(elapsed))} ms)`
    : "";
  if (ok) {
    return `${action
      .replace(
        /^Checking deletion without changing the file:/,
        "Deletion check completed:",
      )
      .replace(/^Reading file:/, "File read completed:")
      .replace(/^Editing file:/, "File edit completed:")
      .replace(/^Deleting file:/, "File deletion completed:")}${timing}`;
  }
  const detail = previewToolOutput(output, maxLength).trim();
  return `${action} failed${detail ? `: ${detail}` : ""}${timing}`;
}

/**
 * Node "category" inferred purely from the tool name — mirrors the
 * frontend's features/monitor/protocol.ts#inferNodeType so backend and
 * frontend agree on what a given tool label represents. The backend does
 * not currently send this on the wire (the frontend infers it independently
 * from `label`); it is exposed here so the mapping itself has a single
 * source of truth and test coverage, and so a future wire field — if ever
 * added back — is guaranteed to match the frontend's own inference instead
 * of silently drifting from it the way the old hardcoded `node_type: "tool"`
 * field did.
 */
export type InspectorNodeType =
  | "tool"
  | "skill"
  | "plugin"
  | "file"
  | "command"
  | "pattern"
  | "system";

export function inferInspectorNodeType(label: string): InspectorNodeType {
  const lower = label.toLowerCase();
  if (lower.startsWith("skill:") || lower.includes("skill_")) return "skill";
  if (lower.startsWith("plugin:") || lower.includes("plugin_"))
    return "plugin";
  if (
    lower.startsWith("file:") ||
    lower.includes("file_") ||
    /(^|[._-])(read|write|create|edit|move|copy|delete)[._-]?file/.test(lower)
  ) {
    return "file";
  }
  if (
    lower.startsWith("command:") ||
    lower.startsWith("shell:") ||
    lower.startsWith("exec:") ||
    lower.includes("terminal") ||
    lower.includes("shell_") ||
    lower.includes("command_") ||
    lower.includes("execute_")
  ) {
    return "command";
  }
  if (
    lower.startsWith("pattern:") ||
    lower.includes("workflow") ||
    lower.includes("orchestrat")
  )
    return "pattern";
  if (lower.startsWith("system:") || lower.includes("system_")) return "system";
  return "tool";
}

export interface MinimalSocket {
  readyState: number;
  send(data: string): void;
}

/** Mirrors the `ws` package's WebSocket.OPEN numeric value (1) without importing `ws`. */
export const SOCKET_OPEN = 1;

export function sendMikiFrame(
  ws: MinimalSocket,
  message: Record<string, unknown>,
): void {
  if (ws.readyState === SOCKET_OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export type InspectorThoughtCategory =
  | "Plan"
  | "Action"
  | "Verification"
  | "Progress"
  | "Decision";

export interface BuildInspectorThoughtInput {
  sessionId: string;
  runId: string;
  content: string;
  category: InspectorThoughtCategory;
  modelName: string;
  now?: () => number;
  /** Called once for the envelope `id`, and once more for the `message_id` suffix — matching the original's two independent crypto.randomUUID() calls. */
  idGenerator?: () => string;
}

/**
 * Builds the exact payload api/index.ts#_sendInspectorThought sends over the
 * socket. Pulled out as a pure builder (no ws/orchestrator dependency) so
 * the `kind: "thought"` + `inspector_only: true` contract — the mechanism
 * that keeps model "thinking" out of the normal chat bubble UI — has direct
 * test coverage. Returns null for blank content, matching the original
 * early-return behavior (no message is sent for empty thoughts).
 */
export function buildInspectorThoughtMessage(
  input: BuildInspectorThoughtInput,
): Record<string, unknown> | null {
  const trimmed = input.content.trim();
  if (!trimmed) return null;
  const now = input.now ?? Date.now;
  const nextId = input.idGenerator ?? (() => "id");
  return {
    type: "message.create",
    id: nextId(),
    session_id: input.sessionId,
    timestamp: now(),
    payload: {
      message_id: `${input.runId}-thought-${nextId()}`,
      run_id: input.runId,
      content: trimmed,
      kind: "thought",
      thought_category: input.category,
      inspector_only: true,
      model_name: input.modelName,
    },
  };
}
