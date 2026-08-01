import { classifyAgentTask, formatAgentTaskProfile } from "./task-profile.js";

describe("agent task profile", () => {
  it("classifies direct questions as simple", () => {
    const profile = classifyAgentTask("What is the current project name?");

    expect(profile.complexity).toBe("simple");
    expect(profile.speedClass).toBe("instant");
    expect(profile.verificationDepth).toBe("none");
    expect(profile.executionStyle).toContain("minimal context");
  });

  it("classifies scoped implementation requests as standard", () => {
    const profile = classifyAgentTask(
      "Fix the config validation test and run it",
    );

    expect(profile.complexity).toBe("standard");
    expect(profile.speedClass).toBe("fastest");
    expect(profile.expectedLatency).toBe("seconds_to_few_minutes");
    expect(profile.verificationDepth).toBe("focused");
    expect(profile.signals).toEqual(
      expect.arrayContaining(["implementation_intent", "verification_needed"]),
    );
  });

  it("classifies plugin or dashboard integration work as medium", () => {
    const profile = classifyAgentTask(
      "Add a dashboard and backend contract update for plugin runtime smoke",
    );

    expect(profile.speedClass).toBe("medium");
    expect(profile.expectedLatency).toBe("few_minutes_to_15_plus_minutes");
    expect(profile.verificationDepth).toBe("integration");
  });

  it("classifies Hiro-style multi-step work as complex", () => {
    const profile = classifyAgentTask(
      "Create an Hiro workflow roadmap, implement production-grade integration, then verify with benchmark and audit checks",
    );

    expect(profile.complexity).toBe("complex");
    expect(profile.speedClass).toBe("heavy");
    expect(profile.expectedLatency).toBe("15_plus_minutes_or_longer");
    expect(profile.executionStyle).toContain("task graph");
    expect(profile.verification).toContain("required");
  });

  it("classifies full release verification as heavy even when urgent", () => {
    const profile = classifyAgentTask(
      "Superfast run the full release verification matrix and pack audit",
    );

    expect(profile.speedClass).toBe("heavy");
    expect(profile.verificationDepth).toBe("release");
    expect(profile.signals).toContain("speed_priority");
  });

  it("formats the profile for system prompt context", () => {
    const profile = classifyAgentTask("Build and test a workflow feature");
    const formatted = formatAgentTaskProfile(profile);

    expect(formatted).toContain("[Task Profile]");
    expect(formatted).toContain(`complexity: ${profile.complexity}`);
    expect(formatted).toContain(`speed_class: ${profile.speedClass}`);
    expect(formatted).toContain(
      `verification_depth: ${profile.verificationDepth}`,
    );
  });

  it("detects explicit speed priority without hiding verification", () => {
    const profile = classifyAgentTask(
      "Superfast fix the plugin workflow and verify it",
    );

    expect(profile.signals).toContain("speed_priority");
    expect(profile.executionStyle).toContain("Fast lane");
    expect(profile.verification).toContain("narrowest meaningful verification");
  });
});
