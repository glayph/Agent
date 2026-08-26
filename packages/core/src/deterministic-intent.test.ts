import {
  detectDeterministicIntent,
  isExplicitToolIntent,
} from "./deterministic-intent.js";
import { routeAgentTask } from "./agent-router.js";
import { selectAdaptiveCapabilities } from "./adaptive-capability-selector.js";
import { classifyAgentTask } from "./task-profile.js";

describe("deterministic intent safeguards", () => {
  it("extracts an explicit web-search query", () => {
    expect(
      detectDeterministicIntent(
        "Search the web for the latest Agent commit and return the source link.",
      ),
    ).toEqual({
      kind: "web_search",
      query: "the latest Agent commit",
      verificationRequested: true,
    });
  });

  it("extracts multiple exact file requests and verification intent", () => {
    expect(
      detectDeterministicIntent(
        "Create multi-one.txt containing exactly one; create multi-two.txt containing exactly two; then verify both files.",
      ),
    ).toEqual({
      kind: "file_workflow",
      files: [
        { path: "multi-one.txt", content: "one" },
        { path: "multi-two.txt", content: "two" },
      ],
      verificationRequested: true,
    });
  });

  it("marks only the required tools as explicit for a file workflow", () => {
    const message =
      "Create task-smoke.txt containing exactly task smoke passed, then verify it exists.";
    expect(isExplicitToolIntent(message, "file_write")).toBe(true);
    expect(isExplicitToolIntent(message, "file_read")).toBe(true);
    expect(isExplicitToolIntent(message, "shell_execute")).toBe(false);
  });

  it("keeps web search and file tools in a simple-turn selection", () => {
    const messages = [
      "Search the web for the latest Agent commit.",
      "Create task-smoke.txt containing exactly passed, then verify it exists.",
    ];
    for (const message of messages) {
      const profile = classifyAgentTask(message);
      const decision = routeAgentTask(message, {}, profile);
      const selection = selectAdaptiveCapabilities(
        message,
        [
          {
            type: "function",
            function: {
              name: "web_search",
              description: "Search the public web",
              parameters: { type: "object", properties: {} },
            },
          },
          {
            type: "function",
            function: {
              name: "file_write",
              description: "Write a file",
              parameters: { type: "object", properties: {} },
            },
          },
          {
            type: "function",
            function: {
              name: "file_read",
              description: "Read a file",
              parameters: { type: "object", properties: {} },
            },
          },
          {
            type: "function",
            function: {
              name: "ask_user",
              description: "Ask the user",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        decision,
        profile,
        { maxTools: 4 },
      );
      if (message.startsWith("Search")) {
        expect(selection.selectedToolNames).toContain("web_search");
      } else {
        expect(selection.selectedToolNames).toEqual(
          expect.arrayContaining(["file_write", "file_read"]),
        );
      }
    }
  });
});
