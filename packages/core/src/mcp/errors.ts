export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mcpErrorContent(error: unknown, prefix = "MCP error") {
  return {
    content: [
      {
        type: "text" as const,
        text: `${prefix}: ${errorMessage(error)}`,
      },
    ],
    isError: true,
  };
}
