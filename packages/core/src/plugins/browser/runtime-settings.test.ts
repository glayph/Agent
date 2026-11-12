import { BrowserTool } from "./runtime.js";

describe("BrowserTool restriction setting", () => {
  it("turns bypass on and restores the safe private-network baseline when disabled", () => {
    const browser = new BrowserTool(false, "data");
    browser.setAllowedDomains(["example.com"]);
    expect(browser.getSecurityPolicySnapshot()).toEqual({ allowPrivateNetworks: false, allowedDomains: ["example.com"] });
    browser.setBypassRestrictions(true);
    expect(browser.getSecurityPolicySnapshot()).toEqual({ allowPrivateNetworks: true, allowedDomains: [] });
    browser.setBypassRestrictions(false);
    expect(browser.getSecurityPolicySnapshot()).toEqual({ allowPrivateNetworks: false, allowedDomains: [] });
  });
});
