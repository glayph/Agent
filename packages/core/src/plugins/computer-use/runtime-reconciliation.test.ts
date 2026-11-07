import { ComputerAgent } from "./runtime.js";

describe("ComputerAgent desktop-state reconciliation", () => {
  it("invalidates element IDs from the previous UI tree after a fresh observation", async () => {
    const computer = new ComputerAgent();
    const runtime = computer as unknown as {
      runPowerShell: jest.Mock;
      locatorFromArgs: (args: Record<string, unknown>) => unknown;
    };
    runtime.runPowerShell = jest.fn(async () => ({
      ok: true,
      action: "observe",
      data: { elements: [{ name: "Example window", controlType: "Window", windowTitle: "Example" }] },
    }));

    const first = JSON.parse(await computer.observe({})) as { data: { elements: Array<{ id: string }> } };
    const staleId = first.data.elements[0].id;
    expect(runtime.locatorFromArgs({ element_id: staleId })).toBeDefined();

    await computer.reconcileAfterCrash();
    expect(() => runtime.locatorFromArgs({ element_id: staleId })).toThrow("Call computer_observe first");
    expect(runtime.runPowerShell).toHaveBeenCalledTimes(2);
  });

  it("returns a timestamped reconciliation result based on live desktop observation", async () => {
    const computer = new ComputerAgent();
    const runtime = computer as unknown as { runPowerShell: jest.Mock };
    runtime.runPowerShell = jest.fn(async () => ({
      ok: true,
      action: "observe",
      data: { activeWindow: { title: "Miki" }, elements: [] },
    }));

    const result = JSON.parse(await computer.reconcileAfterCrash()) as { action: string; reconciledAt: string; data: { activeWindow: { title: string } } };
    expect(result.action).toBe("reconcile");
    expect(Number.isFinite(Date.parse(result.reconciledAt))).toBe(true);
    expect(result.data.activeWindow.title).toBe("Miki");
  });
});
