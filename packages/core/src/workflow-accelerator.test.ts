import {
  buildWorkflowAccelerationPlan,
  buildWorkflowDecisionPattern,
  formatWorkflowDecisionPattern,
  formatWorkflowAccelerationPlan,
} from "./workflow-accelerator.js";
import { classifyAgentTask } from "./task-profile.js";
import { routeAgentTask } from "./agent-router.js";

describe("workflow accelerator", () => {
  it("uses turbo mode for explicit superfast work", () => {
    const profile = classifyAgentTask(
      "Superfast implement plugin runtime verification and run focused tests",
    );
    const decision = routeAgentTask(
      "Superfast implement plugin runtime verification and run focused tests",
      {},
      profile,
    );
    const plan = buildWorkflowAccelerationPlan(profile, decision, {
      maxParallelToolCalls: 3,
    });

    expect(profile.signals).toContain("speed_priority");
    expect(plan.speedClass).toBe("medium");
    expect(plan.verificationDepth).toBe("integration");
    expect(plan.mode).toBe("turbo");
    expect(plan.maxParallelToolCalls).toBeGreaterThanOrEqual(6);
    expect(plan.rules).toEqual(
      expect.arrayContaining(["parallelize_safe_reads"]),
    );
  });

  it("keeps urgent release verification in balanced mode", () => {
    const message =
      "Superfast run the full release verification matrix and pack audit";
    const profile = classifyAgentTask(message);
    const decision = routeAgentTask(message, {}, profile);
    const plan = buildWorkflowAccelerationPlan(profile, decision, {
      maxParallelToolCalls: 8,
    });
    const pattern = buildWorkflowDecisionPattern(profile, decision, plan);

    expect(profile.speedClass).toBe("heavy");
    expect(plan.mode).toBe("balanced");
    expect(plan.verificationDepth).toBe("release");
    expect(pattern.id).toBe("balanced_verification");
  });

  it("builds a turbo implementation decision pattern for fast coding work", () => {
    const message =
      "Superfast implement the config bug fix and run focused verification";
    const profile = classifyAgentTask(message);
    const decision = routeAgentTask(message, {}, profile);
    const plan = buildWorkflowAccelerationPlan(profile, decision, {
      maxParallelToolCalls: 3,
    });
    const pattern = buildWorkflowDecisionPattern(profile, decision, plan);

    expect(pattern.id).toBe("turbo_implementation");
    expect(pattern.speedClass).toBe("fastest");
    expect(pattern.expectedLatency).toBe("seconds_to_few_minutes");
    expect(pattern.verificationDepth).toBe("focused");
    expect(pattern.contextBudget).toEqual(
      expect.objectContaining({
        maxInitialFiles: 8,
        preferCache: true,
      }),
    );
    expect(pattern.parallelism).toEqual(
      expect.objectContaining({
        maxParallelToolCalls: plan.maxParallelToolCalls,
        safeReadParallelism: true,
        serializeWrites: true,
      }),
    );
    expect(pattern.firstPassActions).toEqual(
      expect.arrayContaining(["run_focused_test_or_build"]),
    );
  });

  it("formats acceleration context for the agent system prompt", () => {
    const profile = classifyAgentTask(
      "Plan a production workflow architecture",
    );
    const plan = buildWorkflowAccelerationPlan(profile, undefined, {
      maxParallelToolCalls: 8,
    });
    const formatted = formatWorkflowAccelerationPlan(plan);

    expect(formatted).toContain("[Workflow Acceleration]");
    expect(formatted).toContain("speed_class:");
    expect(formatted).toContain("verification_depth:");
    expect(formatted).toContain("serialize_workspace_writes");
    expect(formatted).toContain("verify_before_final");
  });

  it("formats decision pattern context for the agent system prompt", () => {
    const profile = classifyAgentTask(
      "Plan a production workflow architecture",
    );
    const decision = routeAgentTask(
      "Plan a production workflow architecture",
      {},
      profile,
    );
    const pattern = buildWorkflowDecisionPattern(profile, decision);
    const formatted = formatWorkflowDecisionPattern(pattern);

    expect(formatted).toContain("[Workflow Decision Pattern]");
    expect(formatted).toContain("expected_latency:");
    expect(formatted).toContain("context_budget:");
    expect(formatted).toContain("escalation:");
  });
});
