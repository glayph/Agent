export interface ToolDefinition {
  type: "function";
  risk?: {
    level: "low" | "medium" | "high";
    label: string;
    reason: string;
  };
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolHandler {
  (args: Record<string, unknown>, signal?: AbortSignal): string | Promise<string>;
}
