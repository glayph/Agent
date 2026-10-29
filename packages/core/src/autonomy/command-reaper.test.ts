import { reviewOrphanCommands, type OwnedCommand } from "./command-reaper";

const MIN = 60_000;

function command(overrides: Partial<OwnedCommand> & { id: string; output?: string }): OwnedCommand {
  const output = overrides.output ?? "";
  return {
    command: "npm run build",
    detached: false,
    status: "running",
    startedAt: 0,
    stdout: { tail: () => output },
    stderr: { tail: () => "" },
    ...overrides,
    runId: "runId" in overrides ? overrides.runId : "run-1",
  };
}

describe("reviewOrphanCommands", () => {
  it("never reviews a command whose run is still active", () => {
    const state = new Map();
    const commands = [command({ id: "p1" })];
    const first = reviewOrphanCommands({ commands, isRunActive: () => true, now: 0, idleMs: MIN, state });
    const later = reviewOrphanCommands({ commands, isRunActive: () => true, now: 10 * MIN, idleMs: MIN, state });
    expect(first).toEqual([]);
    expect(later).toEqual([]);
    expect(state.size).toBe(0);
  });

  it("does not review background or unowned commands", () => {
    const state = new Map();
    const commands = [
      command({ id: "bg", detached: true }),
      command({ id: "unowned", runId: undefined }),
      command({ id: "done", status: "exited" }),
    ];
    const isRunActive = () => false;
    reviewOrphanCommands({ commands, isRunActive, now: 0, idleMs: MIN, state });
    const actions = reviewOrphanCommands({ commands, isRunActive, now: 99 * MIN, idleMs: MIN, state });
    expect(actions).toEqual([]);
  });

  it("stops an orphaned command only after it has been silent for the idle limit", () => {
    const state = new Map();
    const commands = [command({ id: "p1", output: "compiling..." })];
    const isRunActive = () => false;
    expect(reviewOrphanCommands({ commands, isRunActive, now: 0, idleMs: 20 * MIN, state })).toEqual([]);
    expect(reviewOrphanCommands({ commands, isRunActive, now: 10 * MIN, idleMs: 20 * MIN, state })).toEqual([]);
    const actions = reviewOrphanCommands({ commands, isRunActive, now: 21 * MIN, idleMs: 20 * MIN, state });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: "p1", command: "npm run build", idleMinutes: 21 });
    expect(actions[0].reason).toContain("printed nothing");
  });

  it("keeps an orphaned command alive while it keeps printing output", () => {
    const state = new Map();
    let output = "step 1";
    const commands = [{ ...command({ id: "p1" }), stdout: { tail: () => output } }];
    const isRunActive = () => false;
    reviewOrphanCommands({ commands, isRunActive, now: 0, idleMs: 20 * MIN, state });
    output = "step 2";
    expect(reviewOrphanCommands({ commands, isRunActive, now: 25 * MIN, idleMs: 20 * MIN, state })).toEqual([]);
    expect(state.get("p1")?.changedAt).toBe(25 * MIN);
  });

  it("forgets commands that are no longer running", () => {
    const state = new Map([["gone", { snapshot: "x", changedAt: 0 }]]);
    reviewOrphanCommands({ commands: [], isRunActive: () => false, now: MIN, idleMs: MIN, state });
    expect(state.size).toBe(0);
  });
});
