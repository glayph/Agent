import { shouldWarnMissingApiKeys } from "./config.js";

describe("config warnings", () => {
  it("keeps missing provider API key warnings disabled by default", () => {
    expect(shouldWarnMissingApiKeys({})).toBe(false);
    expect(
      shouldWarnMissingApiKeys({ Miki_WARN_MISSING_API_KEYS: "false" }),
    ).toBe(false);
  });

  it("allows missing provider API key warnings to be enabled explicitly", () => {
    expect(
      shouldWarnMissingApiKeys({ Miki_WARN_MISSING_API_KEYS: "true" }),
    ).toBe(true);
  });
});
