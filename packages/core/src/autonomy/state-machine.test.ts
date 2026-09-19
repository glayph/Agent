import { AutonomyStateMachine } from "./state-machine.js";

describe("AutonomyStateMachine", () => {
  it("starts in BOOT by default", () => {
    const sm = new AutonomyStateMachine();
    expect(sm.current).toBe("BOOT");
  });

  it("follows the power-on sequence", () => {
    const sm = new AutonomyStateMachine();
    expect(sm.transition("INITIALIZING")).toBe(true);
    expect(sm.transition("ACTIVE")).toBe(true);
    expect(sm.current).toBe("ACTIVE");
  });

  it("rejects illegal transitions without throwing", () => {
    const sm = new AutonomyStateMachine("ACTIVE");
    expect(sm.canTransition("MEMORY_UPDATE")).toBe(false);
    expect(() => sm.transition("MEMORY_UPDATE")).not.toThrow();
    expect(sm.transition("MEMORY_UPDATE")).toBe(false);
    expect(sm.current).toBe("ACTIVE"); // unchanged
  });

  it("walks the full autonomous cycle", () => {
    const sm = new AutonomyStateMachine("ACTIVE");
    expect(sm.transition("IDLE_DECISION")).toBe(true);
    expect(sm.transition("AUTONOMOUS")).toBe(true);
    expect(sm.transition("PLANNING")).toBe(true);
    expect(sm.transition("EXECUTING")).toBe(true);
    expect(sm.transition("OBSERVING")).toBe(true);
    expect(sm.transition("MEMORY_UPDATE")).toBe(true);
    expect(sm.transition("IDLE_DECISION")).toBe(true);
    expect(sm.current).toBe("IDLE_DECISION");
  });

  it("allows a new user task to interrupt from EXECUTING", () => {
    const sm = new AutonomyStateMachine("EXECUTING");
    expect(sm.transition("USER_TASK")).toBe(true);
    expect(sm.transition("ACTIVE")).toBe(true);
  });

  it("notifies listeners on every legal transition", () => {
    const sm = new AutonomyStateMachine("ACTIVE");
    const seen: string[] = [];
    sm.onChange((from, to) => seen.push(`${from}->${to}`));
    sm.transition("SLEEP");
    sm.transition("ACTIVE");
    expect(seen).toEqual(["ACTIVE->SLEEP", "SLEEP->ACTIVE"]);
  });

  it("forceTransition always succeeds, even into SHUTDOWN from anywhere", () => {
    const sm = new AutonomyStateMachine("EXECUTING");
    sm.forceTransition("SHUTDOWN");
    expect(sm.current).toBe("SHUTDOWN");
  });

  it("keeps a bounded history", () => {
    const sm = new AutonomyStateMachine("ACTIVE");
    for (let i = 0; i < 10; i++) {
      sm.transition("SLEEP");
      sm.transition("ACTIVE");
    }
    expect(sm.recentHistory(5)).toHaveLength(5);
  });
});
