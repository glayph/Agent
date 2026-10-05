const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/**
 * Holds the tools the agent may call. Registration is dynamic: tools can be
 * added or removed while the gateway is running (plugins, MCP, skills).
 */
export class ToolRegistry {
    tools = new Map();
    register(tool, options = {}) {
        if (!TOOL_NAME.test(tool.name))
            throw new Error(`Invalid tool name "${tool.name}".`);
        if (this.tools.has(tool.name) && !options.replace)
            throw new Error(`Tool "${tool.name}" is already registered.`);
        this.tools.set(tool.name, tool);
    }
    registerAll(tools, options = {}) {
        for (const tool of tools)
            this.register(tool, options);
    }
    unregister(name) {
        return this.tools.delete(name);
    }
    has(name) {
        return this.tools.has(name);
    }
    get(name) {
        return this.tools.get(name);
    }
    get size() {
        return this.tools.size;
    }
    list() {
        return [...this.tools.values()];
    }
    names() {
        return [...this.tools.keys()];
    }
    /** Tool definitions in the shape LLM providers expect. */
    schemas() {
        return this.list().map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
    }
    /** Whether a call to `tool` must be confirmed by a person first. */
    static needsApproval(tool) {
        if (tool.approval === "auto")
            return false;
        if (tool.approval === "required")
            return true;
        return tool.risk !== "read";
    }
}
