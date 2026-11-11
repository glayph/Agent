import { describe, expect, it } from "vitest";
import { stableToolName } from "./tool-names.js";

describe("stableToolName", () => {
  it("keeps names valid and bounded while distinguishing sanitized identities", () => {
    const slash = stableToolName("plugin_a/b_contract.lookup");
    const underscore = stableToolName("plugin_a_b_contract.lookup");
    expect(slash).not.toBe(underscore);
    expect(slash).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(slash.length).toBeLessThanOrEqual(64);
    expect(stableToolName("x".repeat(300))).toHaveLength(64);
  });
});
