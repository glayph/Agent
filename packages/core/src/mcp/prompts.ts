import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function compactLines(lines: Array<string | false | null | undefined>): string {
  return lines.filter(Boolean).join("\n");
}

export function registerMcpPrompts(server: McpServer): void {
  server.registerPrompt(
    "agent-analysis",
    {
      description: "Analyze agent performance and suggest improvements",
      argsSchema: {
        focus_area: z
          .string()
          .optional()
          .describe(
            "Area to analyze: memory, tools, response-time, planning, or overall",
          ),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: compactLines([
              "Analyze the Hiro agent's performance and suggest improvements.",
              `Focus area: ${args?.focus_area || "overall"}`,
              "",
              "Return a compact report with:",
              "- Findings ordered by impact.",
              "- Evidence from memory, tools, latency, planning, and goals when available.",
              "- Concrete fixes with owner/module and verification signal.",
              "- Avoid generic advice; keep each recommendation actionable.",
            ]),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "task-planning",
    {
      description: "Create a structured task plan for the agent",
      argsSchema: {
        objective: z.string().describe("The objective to accomplish"),
        constraints: z
          .string()
          .optional()
          .describe("JSON constraints or requirements"),
        priority: z
          .enum(["low", "medium", "high", "critical"])
          .optional()
          .describe("Task priority"),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: compactLines([
              "Create a detailed task plan for the Hiro agent.",
              "",
              `Objective: ${args.objective}`,
              `Priority: ${args.priority || "medium"}`,
              `Constraints: ${args.constraints || "none"}`,
              "",
              "Return only:",
              "- Ordered subtasks with dependencies.",
              "- Required tools/resources per subtask.",
              "- Success criteria and verification command or signal.",
              "- Rollback/stop condition for risky steps.",
              "- Complexity per subtask.",
            ]),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "debugging",
    {
      description: "Diagnose and fix issues with the agent",
      argsSchema: {
        issue_description: z
          .string()
          .describe("Description of the issue to debug"),
        recent_logs: z
          .string()
          .optional()
          .describe("Recent error logs or behavior"),
        severity: z
          .enum(["info", "warning", "error", "critical"])
          .optional()
          .describe("Issue severity"),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: compactLines([
              "Debug the following Hiro agent issue.",
              "",
              `Issue: ${args.issue_description}`,
              `Severity: ${args.severity || "error"}`,
              `Recent context: ${args.recent_logs || "no logs provided"}`,
              "",
              "Return only:",
              "- Most likely root cause and why.",
              "- Minimal diagnostics to confirm or falsify it.",
              "- Patch strategy with verification signal.",
              "- Monitoring or regression test to prevent recurrence.",
            ]),
          },
        },
      ],
    }),
  );
}
