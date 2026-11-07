import { DEFAULT_SYSTEM_PROMPT, buildSystemPrompt } from "./prompt.js";

describe("core system prompt", () => {
  it("makes the model check the live runtime before answering about itself", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("first check the live runtime with your tools");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("plugin_list");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("not the underlying language model");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("never answer about yourself from the model's training knowledge");
  });

  it("calls tools for live state and actions, and answers directly only when no tool can help", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("call a tool whenever the answer or the outcome depends on live state");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("answer directly only for plain conversation or general knowledge that no tool can improve");
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("call a tool only when the answer depends on information you do not already have");
  });

  it("still lists the tools of the run", () => {
    const prompt = buildSystemPrompt({ toolNames: ["terminal_run", "plugin_list"] });
    expect(prompt).toContain("Available tools: terminal_run, plugin_list.");
  });
});
