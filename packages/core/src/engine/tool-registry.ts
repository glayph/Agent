import type { EngineTool, EngineToolSchema, ToolApprovalDecision, ToolMonitorPresentation } from "./types.js";

export interface ToolApprovalSettings {
  autoApproveSafe?: boolean;
  /** Disable human approval prompts for all registered agent tools in the isolated owner environment. */
  autoApproveAll?: boolean;
  requireConfirmDestructive?: boolean;
  requireConfirmComputerUse?: boolean;
  unrestrictedMode?: boolean;
  securityAcknowledged?: boolean;
}

export interface ResolvedToolApproval {
  mode: "auto" | "approval" | "block";
  reason: string;
}

/** Resolve every approval layer in one place. Sandbox owner mode suppresses
 * human confirmation prompts without overriding hard capability or deny rules. */
export function resolveToolApproval(
  tool: EngineTool,
  settings: ToolApprovalSettings = {},
  policy?: ToolApprovalDecision,
  learned?: { mode: "auto" | "approval" | "block"; reason: string },
): ResolvedToolApproval {
  if (learned?.mode === "block") return { mode: "block", reason: learned.reason };
  if (policy?.mode === "block") return { mode: "block", reason: policy.reason };

  // Explicit sandbox-owner mode removes confirmation prompts across every
  // EngineTool, including metadata marked `approval: required`. Capability
  // denial and learned explicit block rules still win above.
  if (settings.autoApproveAll === true) {
    return { mode: "auto", reason: "Sandbox owner mode auto-approves tool execution; hard capability and deny policies remain active." };
  }

  if (settings.unrestrictedMode && settings.securityAcknowledged !== true && tool.risk !== "read") {
    return { mode: "block", reason: "Unrestricted system access is not acknowledged. Set risk_acceptance=true, audit_logging=true and provide a non-empty approval_note before enabling write actions." };
  }
  if (settings.requireConfirmComputerUse && tool.name.startsWith("computer_") && tool.risk !== "read") {
    return { mode: "approval", reason: "The runtime configuration requires owner approval for computer-use actions." };
  }
  if (settings.requireConfirmDestructive && ["destructive", "install", "service"].includes(tool.risk)) {
    return { mode: "approval", reason: "The runtime configuration requires owner approval for destructive, install or service actions." };
  }
  if (tool.risk === "read" && settings.autoApproveSafe === false) {
    return { mode: "approval", reason: "Runtime configuration disables automatic approval for safe tools." };
  }
  if (learned?.mode === "approval") return { mode: "approval", reason: learned.reason };
  if (policy?.mode === "approval") return { mode: "approval", reason: policy.reason };
  const highImpact = ["destructive", "install", "service"].includes(tool.risk);
  if (tool.approval === "required" && !(policy?.mode === "auto" && !highImpact)) {
    return { mode: "approval", reason: "This tool is explicitly marked as requiring owner approval." };
  }
  if (policy?.mode === "auto") return { mode: "auto", reason: policy.reason };
  if (tool.approval === "auto") return { mode: "auto", reason: "This tool is explicitly marked as safe for automatic execution." };
  if (tool.risk === "read") {
    return { mode: "auto", reason: "Read-only tools are auto-approved by the safe-tool policy." };
  }
  if (ToolRegistry.needsApproval(tool)) {
    return { mode: "approval", reason: "Non-read-only tool calls require owner approval unless explicitly approved by a trusted runtime policy." };
  }
  return { mode: "auto", reason: "No approval requirement applies." };
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Classify registered capabilities once, at the trusted registry boundary. */
export function defaultToolMonitorPresentation(name: string): ToolMonitorPresentation {
  if (name === "web_search") return { category: "search", iconKey: "search", displayName: "Web Search" };
  if (name.startsWith("browser_")) return { category: "browser", iconKey: "browser", displayName: "Browser" };
  if (name.startsWith("computer_")) return { category: "computer", iconKey: "computer", displayName: "Computer" };
  if (name.startsWith("terminal_") || name.startsWith("shell_") || name.startsWith("command_")) return { category: "terminal", iconKey: "terminal", displayName: "Terminal" };
  if (name.startsWith("file_") || name.startsWith("workspace_")) return { category: "file", iconKey: "file", displayName: "Files" };
  if (name.startsWith("memory_")) return { category: "memory", iconKey: "memory", displayName: "Memory" };
  if (name.startsWith("skill_")) return { category: "skill", iconKey: "skill", displayName: "Skill" };
  if (name.startsWith("plugin_")) return { category: "plugin", iconKey: "plugin", displayName: "Plugin" };
  if (name.includes("__")) return { category: "mcp", iconKey: "mcp", displayName: "MCP Tool" };
  return { category: "tool", iconKey: "tool", displayName: "Tool" };
}

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
    this.tools.set(tool.name, tool.monitor ? tool : { ...tool, monitor: defaultToolMonitorPresentation(tool.name) });
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
