import type { ToolDefinition } from "../../../../mcp/contracts/tools.js";
import type { MikiProviderMessage } from "../../sdk/index.js";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Gemini's OpenAI-compatible endpoint accepts a deliberately small JSON Schema
 * subset for function declarations. Keep the provider payload conservative:
 * local risk metadata never crosses the boundary, unsupported unions are
 * represented by their first compatible branch, and empty required arrays are
 * omitted instead of being sent as invalid schema declarations.
 */
export function normalizeGeminiSchema(value: unknown): JsonObject {
  if (!isRecord(value)) return { type: "object", properties: {} };

  if (Array.isArray(value.oneOf) && value.oneOf.length > 0) {
    const first = value.oneOf.find((item) => isRecord(item)) ?? value.oneOf[0];
    const normalized = normalizeGeminiSchema(first);
    if (typeof value.description === "string")
      normalized.description = value.description;
    return normalized;
  }

  if (Array.isArray(value.anyOf) && value.anyOf.length > 0) {
    const first = value.anyOf.find((item) => isRecord(item)) ?? value.anyOf[0];
    const normalized = normalizeGeminiSchema(first);
    if (typeof value.description === "string")
      normalized.description = value.description;
    return normalized;
  }

  const result: JsonObject = {};
  const type = value.type;
  if (typeof type === "string") {
    result.type = type === "integer" ? "number" : type;
  }
  if (typeof value.description === "string")
    result.description = value.description;

  if (isRecord(value.properties)) {
    const properties: JsonObject = {};
    for (const [key, child] of Object.entries(value.properties)) {
      properties[key] = normalizeGeminiSchema(child);
    }
    result.properties = properties;
  }

  if (value.items !== undefined)
    result.items = normalizeGeminiSchema(value.items);
  if (Array.isArray(value.enum))
    result.enum = value.enum.filter((item) =>
      ["string", "number", "boolean"].includes(typeof item),
    );
  if (Array.isArray(value.required) && value.required.length > 0) {
    result.required = value.required.filter(
      (item): item is string => typeof item === "string",
    );
  }

  if (result.type === undefined) {
    result.type = isRecord(result.properties) ? "object" : "string";
  }
  if (result.type === "object" && result.properties === undefined)
    result.properties = {};
  return result;
}

export function normalizeGeminiMessages(
  messages: MikiProviderMessage[],
): MikiProviderMessage[] {
  return messages.flatMap((message) => {
    const candidate = message as unknown as Record<string, unknown>;
    const role =
      candidate.role === "system" ||
      candidate.role === "user" ||
      candidate.role === "assistant"
        ? candidate.role
        : candidate.role === "tool"
          ? "user"
          : "user";

    if (candidate.role === "tool") {
      const toolName =
        typeof candidate.name === "string" && candidate.name.trim()
          ? ` (${candidate.name.trim()})`
          : "";
      return [
        {
          role: "user",
          content: `Tool result${toolName}: ${String(candidate.content ?? "")}`,
        } as MikiProviderMessage,
      ];
    }

    // Gemini's OpenAI-compatible endpoint can reject a continuation that
    // contains OpenAI-style assistant.tool_calls followed by role=tool. Keep
    // the execution trace as ordinary assistant text; the next request still
    // includes the available tools, so Gemini can select the next operation.
    if (role === "assistant" && Array.isArray(candidate.tool_calls)) {
      const content = String(candidate.content ?? "").trim();
      return [
        {
          role: "assistant",
          content: content || "The requested tool operation was executed.",
        } as MikiProviderMessage,
      ];
    }

    return [
      {
        role,
        content: candidate.content ?? "",
      } as MikiProviderMessage,
    ];
  });
}

export function normalizeGeminiTools(tools: unknown): ToolDefinition[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!isRecord(tool)) return [];
    const fn = isRecord(tool.function) ? tool.function : tool;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) return [];
    const description =
      typeof fn.description === "string" ? fn.description : "";
    return [
      {
        type: "function" as const,
        function: {
          name,
          description,
          parameters: normalizeGeminiSchema(fn.parameters),
        },
      },
    ];
  });
}

export function normalizeGeminiExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!extra) return {};
  const normalized: Record<string, unknown> = { ...extra };
  if (Array.isArray(extra.tools))
    normalized.tools = normalizeGeminiTools(extra.tools);
  // Gemini's OpenAI-compatible endpoint infers automatic tool selection from
  // the presence of `tools`; it rejects the OpenAI-only `tool_choice: auto`
  // field on some model versions with a generic HTTP 400.
  if (normalized.tool_choice === "auto") delete normalized.tool_choice;
  for (const key of Object.keys(normalized)) {
    if (normalized[key] === undefined) delete normalized[key];
  }
  return normalized;
}
