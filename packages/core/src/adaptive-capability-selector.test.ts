import type { ToolDefinition } from "./mcp/contracts/tools.js";
import { routeAgentTask } from "./agent-router.js";
import { selectAdaptiveCapabilities } from "./adaptive-capability-selector.js";
import { classifyAgentTask } from "./task-profile.js";

function tool(name: string, description: string): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: {} },
    },
  };
}

describe("adaptive capability selector", () => {
  it("prioritizes the selected specialist tools without exposing the full catalog", () => {
    const message = "Research current sources and compare the results";
    const profile = classifyAgentTask(message);
    const decision = routeAgentTask(message, {}, profile);
    const allTools = [
      tool("shell_execute", "Execute local commands"),
      tool("file_read", "Read a local file"),
      tool("web_search", "Search the web for sources"),
      tool("scrape_page", "Read and extract a web page"),
      tool("computer_observe", "Observe the desktop"),
      tool("model_list", "List configured models"),
    ];

    const selection = selectAdaptiveCapabilities(
      message,
      allTools,
      decision,
      profile,
      { maxTools: 4 },
    );

    expect(selection.selectedToolNames).toContain("web_search");
    expect(selection.selectedToolNames).toContain("scrape_page");
    expect(selection.selectedToolNames.length).toBeLessThanOrEqual(4);
    expect(selection.context).toBe("research");
    expect(selection.rationale).toContain("specialist_tools_prioritized");
  });

  it("retains file and browser tools for artifact workflows", () => {
    const message =
      "Create index.html, open it in the browser, capture a screenshot, and attach the files";
    const profile = classifyAgentTask(message);
    const decision = routeAgentTask(message, {}, profile);
    const allTools = [
      tool("file_write", "Write a local file"),
      tool("file_read", "Read a local file"),
      tool("browser_navigate", "Open a browser page"),
      tool("browser_extract", "Extract browser content"),
      tool("browser_screenshot", "Capture a browser screenshot"),
      tool("memory_search", "Search memory"),
    ];

    const selection = selectAdaptiveCapabilities(
      message,
      allTools,
      decision,
      profile,
    );

    expect(selection.selectedToolNames).toEqual(
      expect.arrayContaining([
        "file_write",
        "file_read",
        "browser_navigate",
        "browser_extract",
        "browser_screenshot",
      ]),
    );
    expect(selection.rationale.join(" ")).toContain("required_tools");
  });

  it("keeps an available read-only fallback when the request is ambiguous", () => {
    const message = "Help me with this";
    const profile = classifyAgentTask(message);
    const decision = routeAgentTask(message, {}, profile);
    const selection = selectAdaptiveCapabilities(
      message,
      [
        tool("file_read", "Read a local file"),
        tool("file_write", "Write a local file"),
        tool("ask_user", "Ask the user for clarification"),
      ],
      decision,
      profile,
      { maxTools: 2 },
    );

    expect(selection.selectedToolNames).toContain("ask_user");
    expect(selection.selectedToolNames).not.toContain("file_write");
  });
});
