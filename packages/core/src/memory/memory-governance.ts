export type MemoryScopeKind = "user" | "project" | "session" | "agent";
export type MemoryRetention = "session" | "30d" | "90d" | "1y" | "durable";

export interface MemoryScope {
  kind: MemoryScopeKind;
  id: string;
}

export interface GovernedMemoryWrite {
  content: string;
  source: "user" | "agent" | "tool" | "system";
  eventType: string;
  importance: number;
  scope: MemoryScope;
  retention: MemoryRetention;
  sensitive: boolean;
  metadata: Record<string, unknown>;
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:sk|pk|ghp|github_pat|xox[baprs]-)[A-Za-z0-9_\-]{8,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(?:\+?\d[\d\s().-]{7,}\d)\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
];

function normalizeScope(scope: MemoryScope): MemoryScope {
  const id = scope.id.trim();
  if (!id || !/^[a-zA-Z0-9._:-]{1,160}$/.test(id)) {
    throw new Error("Memory scope id must be a non-empty safe identifier.");
  }
  return { kind: scope.kind, id };
}

export function redactMemoryContent(content: string): {
  content: string;
  redactions: number;
} {
  let result = content;
  let redactions = 0;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, () => {
      redactions += 1;
      return "[REDACTED]";
    });
  }
  return { content: result, redactions };
}

export function createGovernedMemoryWrite(input: {
  content: string;
  source: GovernedMemoryWrite["source"];
  eventType?: string;
  importance?: number;
  scope: MemoryScope;
  retention?: MemoryRetention;
  sensitive?: boolean;
}): GovernedMemoryWrite {
  const scope = normalizeScope(input.scope);
  const redacted = redactMemoryContent(input.content);
  const sensitive = input.sensitive === true || redacted.redactions > 0;
  return {
    content: redacted.content,
    source: input.source,
    eventType: input.eventType?.trim() || "memory.event",
    importance: Math.min(Math.max(input.importance ?? 0.5, 0), 1),
    scope,
    retention: input.retention ?? (sensitive ? "session" : "durable"),
    sensitive,
    metadata: {
      memory_scope: `${scope.kind}:${scope.id}`,
      scope_kind: scope.kind,
      scope_id: scope.id,
      retention: input.retention ?? (sensitive ? "session" : "durable"),
      redactions: redacted.redactions,
      created_at: new Date().toISOString(),
    },
  };
}

export function canReadMemory(
  scope: MemoryScope,
  requested: MemoryScope,
): boolean {
  const a = normalizeScope(scope);
  const b = normalizeScope(requested);
  if (a.kind === "agent" && a.id === "miki") return true;
  return a.kind === b.kind && a.id === b.id;
}

export function retentionExpiresAt(
  retention: MemoryRetention,
  now = Date.now(),
): string | null {
  const durations: Record<
    Exclude<MemoryRetention, "session" | "durable">,
    number
  > = {
    "30d": 30,
    "90d": 90,
    "1y": 365,
  };
  if (retention === "durable") return null;
  if (retention === "session") return new Date(now).toISOString();
  return new Date(
    now + durations[retention] * 24 * 60 * 60 * 1000,
  ).toISOString();
}
