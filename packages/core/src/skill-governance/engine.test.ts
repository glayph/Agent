import { SkillGovernanceEngine } from "./engine.js";

describe("SkillGovernanceEngine", () => {
  it("does not apply rules when governance is disabled", () => {
    const engine = new SkillGovernanceEngine({ enabled: false });

    expect(engine.getRuleViolations("file_delete", {})).toEqual([]);
    expect(engine.getStatus()).toMatchObject({
      enabled: false,
      rules_count: 0,
    });
  });

  it("loads protective default rules when governance is enabled", () => {
    const engine = new SkillGovernanceEngine({ enabled: true });

    expect(engine.getStatus()).toMatchObject({ enabled: true, rules_count: 3 });
    expect(engine.getRuleViolations("file_delete", {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "block",
          rule_id: "destructive-file-delete",
        }),
      ]),
    );
    expect(engine.getRuleViolations("shell_execute", {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "warn",
          rule_id: "shell-execution-review",
        }),
      ]),
    );
  });
});
