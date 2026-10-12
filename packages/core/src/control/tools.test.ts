import { createControlToolFactory } from "./tools.js";

describe("control tools", () => {
  it("exposes only typed operations; free-text interpretation is the model's job", () => {
    const factory = createControlToolFactory({} as never);
    expect(factory.definitions.map((definition) => definition.name)).toEqual([
      "agent_control_capabilities",
      "agent_control_state",
      "agent_control_plan",
      "agent_control_execute",
    ]);
  });

  it("rejects the removed free-text request tool", async () => {
    const factory = createControlToolFactory({} as never);
    await expect(factory.execute("agent_control_request", { message: "enable the browser tool" })).rejects.toThrow(
      "Unknown control tool",
    );
  });
});
