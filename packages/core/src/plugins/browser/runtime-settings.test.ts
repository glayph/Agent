import { BrowserTool } from "./runtime.js";

describe("BrowserTool restriction setting", () => {
  it("turns bypass on and restores the safe private-network baseline when disabled", () => {
    const browser = new BrowserTool(true, "data") as unknown as {
      setBypassRestrictions: (enabled: boolean) => void;
      _allowPrivateNetworks: boolean;
      _allowedDomains: string[];
    };

    browser._allowedDomains = ["example.com"];
    expect(browser._allowPrivateNetworks).toBe(false);
    browser.setBypassRestrictions(true);
    expect(browser._allowPrivateNetworks).toBe(true);
    expect(browser._allowedDomains).toEqual([]);
    browser.setBypassRestrictions(false);
    expect(browser._allowPrivateNetworks).toBe(false);
  });
});