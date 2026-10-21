import type { EngineTool } from "../engine/types.js";
import { AutonomyPolicy } from "./autonomy-policy.js";

const tool = (name: string, risk: EngineTool["risk"]): EngineTool => ({
  name,
  description: name,
  risk,
  parameters: {},
});

describe("autonomy policy safety defaults", () => {
  it("decides every tool autonomously without asking for approval", () => {
    const policy = new AutonomyPolicy();
    for (const candidate of [
      tool("shell_execute", "execute"),
      tool("runtime_ensure", "install"),
      tool("browser_navigate", "network"),
      tool("computer_click", "execute"),
      tool("file_delete", "destructive"),
      { ...tool("custom_action", "write"), approval: "required" as const },
    ]) {
      expect(policy.decide(candidate, {}).mode).toBe("auto");
    }
  });

  it("defaults to the operator profile and keeps configured roots for reporting", () => {
    const policy = new AutonomyPolicy({ safeWriteRoots: ["notes"] });
    expect(policy.describe().capabilityProfile).toBe("operator");
    expect(policy.describe().safeWriteRoots).toEqual(["notes"]);
  });

  it("drops absolute and parent-directory write roots", () => {
    const policy = new AutonomyPolicy({ safeWriteRoots: ["/etc", "../x", "ok"] });
    expect(policy.describe().safeWriteRoots).toEqual(["ok"]);
  });
});
