import type { EngineTool } from "../engine/types.js";
import { AutonomyPolicy } from "./autonomy-policy.js";

const tool = (name: string, risk: EngineTool["risk"]): EngineTool => ({
  name,
  description: name,
  risk,
  parameters: { type: "object" },
  execute: () => null,
});

describe("AutonomyPolicy", () => {
  const policy = new AutonomyPolicy({ safeWriteRoots: ["autonomy", "identity/memory"] });

  it("auto-allows only explicitly allowlisted read tools", () => {
    expect(policy.decide(tool("file_read", "read"), { path: "README.md" }).mode).toBe("auto");
    expect(policy.decide(tool("workspace_search", "read"), { query: "hello" }).mode).toBe("auto");
    expect(policy.decide(tool("new_unreviewed_tool", "read"), {}).mode).toBe("block");
    expect(policy.decide({ ...tool("file_read", "read"), approval: "required" }, { path: "README.md" }).mode).toBe("block");
  });

  it("blocks oversized writes and invalid memory additions", () => {
    const bounded = new AutonomyPolicy({ safeWriteRoots: ["autonomy"], maxWriteChars: 4, maxMemoryChars: 5 });
    expect(bounded.decide(tool("file_write", "config_write"), { path: "autonomy/a.txt", content: "12345" }).mode).toBe("block");
    expect(bounded.decide(tool("memory_add", "config_write"), { content: "   " }).mode).toBe("block");
    expect(bounded.decide(tool("memory_add", "config_write"), { content: "123456" }).mode).toBe("block");
    expect(bounded.decide(tool("memory_add", "config_write"), { content: "12345" }).mode).toBe("auto");
  });

  it("rejects absolute and Windows-style paths", () => {
    expect(policy.decide(tool("file_write", "config_write"), { path: "/autonomy/a.txt", content: "x" }).mode).toBe("block");
    expect(policy.decide(tool("file_write", "config_write"), { path: "C:\\autonomy\\a.txt", content: "x" }).mode).toBe("block");
  });

  it("auto-allows new files only inside safe roots", () => {
    expect(policy.decide(tool("file_write", "config_write"), { path: "autonomy/notes.txt", content: "x" }).mode).toBe("auto");
    expect(policy.decide(tool("file_write", "config_write"), { path: "src/notes.txt", content: "x" }).mode).toBe("block");
    expect(policy.decide(tool("file_write", "config_write"), { path: "../autonomy/notes.txt", content: "x" }).mode).toBe("block");
    expect(policy.decide(tool("file_write", "config_write"), { path: "autonomy/../src/notes.txt", content: "x" }).mode).toBe("block");
    expect(policy.decide(tool("file_write", "config_write"), { path: "autonomy/notes.txt", content: "x", overwrite: true }).mode).toBe("block");
  });

  it("restricts directory creation to safe roots", () => {
    expect(policy.decide(tool("file_mkdir", "config_write"), { path: "autonomy/cache" }).mode).toBe("auto");
    expect(policy.decide(tool("file_mkdir", "config_write"), { path: "src/generated" }).mode).toBe("block");
  });

  it("allows browser access only for explicitly allowlisted domains", () => {
    const browserPolicy = new AutonomyPolicy({
      safeWriteRoots: ["autonomy"],
      allowBrowser: true,
      browserAllowedDomains: ["example.com"],
    });
    expect(browserPolicy.decide(tool("browser_navigate", "config_write"), { url: "https://example.com/app" }).mode).toBe("auto");
    expect(browserPolicy.decide(tool("browser_navigate", "config_write"), { url: "https://evil.example.net/" }).mode).toBe("block");
    expect(browserPolicy.decide(tool("browser_extract", "read"), {}).mode).toBe("auto");
  });

  it("supports Phase-2 capability profiles without making external side effects implicit", () => {
    const developer = new AutonomyPolicy({ capabilityProfile: "developer" });
    expect(developer.decide(tool("shell_execute", "install"), { cmd: "npm test" }).mode).toBe("block");
    const developerWithShellGrant = new AutonomyPolicy({ capabilityProfile: "developer", allowedTools: ["shell_execute"] });
    expect(developerWithShellGrant.decide(tool("shell_execute", "install"), { cmd: "npm test" }).mode).toBe("auto");
    expect(developer.decide(tool("dangerous_api", "destructive"), {}).mode).toBe("block");

    const operator = new AutonomyPolicy({
      capabilityProfile: "operator",
      allowedExternalSideEffectTools: ["send_email"],
    });
    expect(operator.decide(tool("send_email", "config_write"), { to: "example@example.com" }).mode).toBe("auto");
    const developerWithGrant = new AutonomyPolicy({ capabilityProfile: "developer", allowedExternalSideEffectTools: ["send_email"] });
    expect(developerWithGrant.decide(tool("send_email", "config_write"), {}).mode).toBe("block");
  });

  it("keeps computer-use disabled and fail-closed for state-changing actions", () => {
    expect(policy.decide(tool("computer_observe", "read"), {}).mode).toBe("block");
    const enabled = new AutonomyPolicy({ allowComputerUse: true });
    expect(enabled.decide(tool("computer_observe", "read"), {}).mode).toBe("auto");
    expect(enabled.decide(tool("computer_set_text", "config_write"), {}).mode).toBe("block");
    const operator = new AutonomyPolicy({ allowComputerUse: true, capabilityProfile: "operator", allowedTools: ["computer_set_text"] });
    expect(operator.decide(tool("computer_set_text", "config_write"), {}).mode).toBe("auto");
  });
  it("fails closed in the safe profile for shell execution even when an explicit tool list is malformed", () => {
    const safe = new AutonomyPolicy({ capabilityProfile: "safe", allowedTools: ["shell_execute"] });
    expect(safe.decide(tool("shell_execute", "install"), { cmd: "npm test" }).mode).toBe("block");
  });

  it("requires an explicit browser domain for read extraction and screenshots", () => {
    const policy = new AutonomyPolicy({ allowBrowser: true, browserAllowedDomains: [] });
    expect(policy.decide(tool("browser_extract", "read"), {}).mode).toBe("block");
    expect(policy.decide(tool("browser_screenshot", "read"), {}).mode).toBe("block");
  });

  it("gates terminal_run exactly like shell_execute", () => {
    const safe = new AutonomyPolicy({ capabilityProfile: "safe", allowedTools: ["terminal_run"] });
    expect(safe.decide(tool("terminal_run", "destructive"), { command: "ls" }).mode).toBe("block");
    const ungranted = new AutonomyPolicy({ capabilityProfile: "operator" });
    expect(ungranted.decide(tool("terminal_run", "destructive"), { command: "ls" }).mode).toBe("block");
    const granted = new AutonomyPolicy({ capabilityProfile: "operator", allowedTools: ["terminal_run"] });
    expect(granted.decide(tool("terminal_run", "destructive"), { command: "ls" }).mode).toBe("auto");
  });

  it("auto-allows read-only web_search", () => {
    expect(policy.decide(tool("web_search", "read"), { query: "node 22 release" }).mode).toBe("auto");
  });

});
