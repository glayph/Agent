export interface ParsedToolArguments {
  toolArgs: Record<string, unknown>;
  parseError?: string;
}

export function parseToolArguments(toolName: string, rawArguments: unknown): ParsedToolArguments {
  const raw = typeof rawArguments === "string" ? rawArguments : "";
  try {
    const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        toolArgs: {},
        parseError: `Tool '${toolName}' arguments must be a JSON object.`,
      };
    }
    return { toolArgs: parsed as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      toolArgs: {},
      parseError: `Tool '${toolName}' arguments were not valid JSON: ${message}`,
    };
  }
}

export function detectTextToolCall(content: string): { toolName: string } | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 16_000) return null;
  const candidate = trimmed
    .replace(/^```(?:json|tool|javascript)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;

  try {
    const value = JSON.parse(candidate) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const fn = record.function;
    const fnName =
      fn && typeof fn === "object"
        ? (fn as Record<string, unknown>).name
        : undefined;
    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.tool === "string"
          ? record.tool
          : typeof fnName === "string"
            ? fnName
            : "";
    if (
      !name ||
      !/^(file_|shell_|browser_|computer_|scrape_|model_|runtime_|project_|web_search|platform_)/i.test(
        name,
      )
    ) {
      return null;
    }
    return { toolName: name };
  } catch {
    return null;
  }
}
