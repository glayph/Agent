import type { ToolDefinition } from "../mcp/contracts/tools.js";
import type { FileMemoryService } from "./service.js";

/**
 * Agent-facing memory tools, named after OpenClaw's: memory_search and
 * memory_get (read), plus memory_note — a controlled way to save a durable
 * fact ("remember this") so the agent never has to rewrite MEMORY.md with a
 * raw file_write.
 */
export function memoryToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: "function",
      risk: { level: "low", label: "Low risk", reason: "Reads Miki's own memory notes." },
      function: {
        name: "memory_search",
        description:
          "Search Miki's memory notes (MEMORY.md, daily notes, session summaries, compaction archives) for earlier facts, decisions, preferences or work. Use before answering questions about the past or what the user said/asked to remember. মেমরি থেকে খুঁজুন।",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to look for (keywords or a short question)." },
            limit: { type: "number", description: "Max results (default 5, max 20)." },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      risk: { level: "low", label: "Low risk", reason: "Reads Miki's own memory notes." },
      function: {
        name: "memory_get",
        description:
          "Read a memory file returned by memory_search (e.g. MEMORY.md or memory/2026-09-28.md), optionally a line range. A file that does not exist yet returns empty text.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Memory file path relative to the memory root." },
            from: { type: "number", description: "First line (1-based). Optional." },
            lines: { type: "number", description: "How many lines. Optional (default 80)." },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      risk: { level: "low", label: "Low risk", reason: "Appends a note to Miki's own memory files." },
      function: {
        name: "memory_note",
        description:
          "Save something to memory. Use scope=long_term for durable facts, decisions and preferences (MEMORY.md); scope=daily for running context (today's note). Call this when the user says 'remember this' / 'মনে রাখো'. Never store passwords or secrets.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The fact/decision to remember, one self-contained statement." },
            scope: { type: "string", enum: ["long_term", "daily"], description: "Default: long_term." },
          },
          required: ["text"],
        },
      },
    },
  ];
}

export const MEMORY_TOOL_NAMES = ["memory_search", "memory_get", "memory_note"] as const;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asNumber(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export async function runMemoryTool(
  service: FileMemoryService | null | undefined,
  name: (typeof MEMORY_TOOL_NAMES)[number],
  args: Record<string, unknown>,
): Promise<string> {
  if (!service || !service.isEnabled())
    return JSON.stringify({ ok: false, error: "File memory is disabled (agent.memory.files.enabled=false)." });
  try {
    if (name === "memory_search") {
      const query = asString(args["query"]).trim();
      if (!query) return JSON.stringify({ ok: false, error: "query is required" });
      const results = await service.search(query, asNumber(args["limit"]) ?? 5);
      return JSON.stringify({ ok: true, count: results.length, results });
    }
    if (name === "memory_get") {
      const r = await service.get(asString(args["path"]), asNumber(args["from"]), asNumber(args["lines"]));
      return JSON.stringify({ ok: !r.error, ...r });
    }
    const text = asString(args["text"]).trim();
    if (!text) return JSON.stringify({ ok: false, error: "text is required" });
    const scope = args["scope"] === "daily" ? "daily" : "long_term";
    const saved = await service.note(text, scope);
    return JSON.stringify({ ok: true, scope, saved: saved.path, duplicate: saved.duplicate });
  } catch (err) {
    // A failing memory tool reports the failure; it never throws into the turn.
    return JSON.stringify({ ok: false, error: (err as Error).message });
  }
}
