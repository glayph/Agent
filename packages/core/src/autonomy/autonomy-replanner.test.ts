import { AutonomyReplanner } from "./autonomy-replanner.js";

describe("AutonomyReplanner", () => {
  const replanner = new AutonomyReplanner();

  it("classifies blocked attempts and forbids blindly repeating them", () => {
    const context = replanner.build({
      goalId: 7,
      goalTitle: "Publish report",
      attempt: 2,
      result: { status: "completed", finalText: "BLOCKED: publication requires approval.", error: undefined },
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(context.kind).toBe("blocked");
    expect(context.instruction).toMatch(/Do not repeat/);
    expect(replanner.toPrompt(context)).toContain("REPLAN REQUIRED");
  });

  it("treats failed execution as evidence for a different approach", () => {
    const context = replanner.build({
      goalId: 8,
      goalTitle: "Inspect build",
      attempt: 1,
      result: { status: "failed", finalText: "", error: "command exited with code 1" },
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(context.kind).toBe("failed");
    expect(context.evidence).toContain("code 1");
    expect(context.instruction).toMatch(/change the approach/i);
  });

  it("treats an unverified completion as a verification failure", () => {
    const context = replanner.build({
      goalId: 9,
      goalTitle: "Create artifact",
      attempt: 3,
      result: { status: "completed", finalText: "Created file, but no verification evidence.", error: undefined },
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(context.kind).toBe("verification_failed");
    expect(context.instruction).toMatch(/acceptance condition/i);
  });
});
