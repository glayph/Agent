import { describe, expect, it } from "@jest/globals";
import { toolEffectConfirmation } from "./tool-effect.js";

describe("toolEffectConfirmation", () => {
  it("confirms only an explicitly delivered effect", () => {
    expect(toolEffectConfirmation({ delivered: true, sent: true })).toBe(true);
  });

  it("does not confirm a message when every destination failed or remained queued", () => {
    expect(toolEffectConfirmation({
      delivered: false,
      sent: false,
      reason: "No destination acknowledged delivery.",
      delivery: { delivered: 0, queued: 1 },
    })).toBe(false);
  });

  it("keeps missing delivery evidence unknown rather than assuming success", () => {
    expect(toolEffectConfirmation({ sent: true })).toBe(undefined);
    expect(toolEffectConfirmation("message queued")).toBe(undefined);
  });
});
