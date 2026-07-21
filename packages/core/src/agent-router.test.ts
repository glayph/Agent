import {
  formatAgentRouteDecision,
  routeAgentTask,
  summarizeAgentRoute,
} from "./agent-router.js";

describe("agent router", () => {
  it("routes implementation requests through Miki", () => {
    const decision = routeAgentTask("Fix the TypeScript API test and run it");

    expect(decision.enabled).toBe(true);
    expect(decision.mode).toBe("single_orchestrator");
    expect(decision.selected.id).toBe("miki");
    expect(decision.profile.speedClass).toBe("fastest");
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["signal:implementation_intent"]),
    );
  });

  it("uses config-defined Miki profile details when routing evidence is stronger", () => {
    const decision = routeAgentTask("Design a marketplace onboarding flow", {
      agents: {
        router: { min_score: 1 },
        specialists: {
          miki: {
            name: "Miki",
            persona: "Focus on plugin marketplace onboarding and trust gates.",
            capabilities: ["marketplace", "onboarding"],
            keywords: ["marketplace", "onboarding"],
            complexities: ["standard", "complex"],
            priority: 20,
            tools: ["project_workflow_create"],
          },
        },
      },
    });

    expect(decision.selected.id).toBe("miki");
    expect(decision.selected.persona).toContain("trust gates");
    expect(summarizeAgentRoute(decision)).toEqual(
      expect.objectContaining({
        agentId: "miki",
        agentName: "Miki",
        speedClass: "medium",
        verificationDepth: "integration",
      }),
    );
  });

  it("falls back to the configured default when router score is too weak", () => {
    const decision = routeAgentTask("hello", {
      agents: {
        router: { default_agent: "miki", min_score: 100 },
      },
    });

    expect(decision.selected.id).toBe("miki");
    expect(decision.reasons).toEqual(["fallback_default_agent"]);
  });

  it("can be explicitly disabled without losing route summary shape", () => {
    const decision = routeAgentTask("Fix the runtime", {
      agents: {
        router: { enabled: false },
      },
    });

    expect(decision.enabled).toBe(false);
    expect(decision.selected.id).toBe("miki");
    expect(summarizeAgentRoute(decision)).toEqual(
      expect.objectContaining({
        enabled: false,
        mode: "single_orchestrator",
      }),
    );
  });

  it("formats selected specialist context for the system prompt", () => {
    const formatted = formatAgentRouteDecision(
      routeAgentTask("Implement production integration tests"),
    );

    expect(formatted).toContain("[Agent Route]");
    expect(formatted).toContain("selected: miki");
    expect(formatted).toContain("speed_class:");
    expect(formatted).toContain("verification_depth:");
    expect(formatted).toContain("specialist_persona:");
    expect(formatted).toContain("preferred_tools:");
  });
});
