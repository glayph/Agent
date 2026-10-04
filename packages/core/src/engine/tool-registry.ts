import type { EngineTool, EngineToolSchema } from "./types.js";

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Holds the tools the agent may call. Registration is dynamic: tools can be
 * added or removed while the gateway is running (plugins, MCP, skills).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, EngineTool>();

  register(tool: EngineTool, options: { replace?: boolean } = {}): void {
    if (!TOOL_NAME.test(tool.name))
      throw new Error(`Invalid tool name "${tool.name}".`);
    if (this.tools.has(tool.name) && !options.replace)
      throw new Error(`Tool "${tool.name}" is already registered.`);
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: EngineTool[], options: { replace?: boolean } = {}): void {
    for (const tool of tools) this.register(tool, options);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): EngineTool | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }

  list(): EngineTool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Tool definitions in the shape LLM providers expect. */
  schemas(): EngineToolSchema[] {
    return this.list().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /** Whether a call to `tool` must be confirmed by a person first. */
  static needsApproval(tool: EngineTool): boolean {
    if (tool.approval === "auto") return false;
    if (tool.approval === "required") return true;
    return tool.risk !== "read";
  }
}
