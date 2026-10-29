import type { EngineTool } from "../engine/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomyPolicy } from "./autonomy-policy.js";

const tool = (name: string, risk: EngineTool["risk"]): EngineTool => ({
  name,
  description: name,
  risk,
  parameters: {},
});

describe("autonomy policy safety defaults", () => {
  it("blocks tools outside the exact execution allowlist", () => {
    const policy = new AutonomyPolicy({ allowedTools: ["file_read"] });
    expect(policy.decide(tool("file_read", "read"), { path: "notes.txt" }).mode).toBe("auto");
    expect(policy.decide(tool("terminal_run", "execute"), { command: "echo unsafe" })).toMatchObject({
      mode: "block",
      reason: expect.stringContaining("explicit capability allowlist"),
    });
  });

  it("enforces safe write roots and explicit side-effect opt-in", () => {
    const policy = new AutonomyPolicy({
      safeWriteRoots: ["notes"],
      allowedTools: ["file_write", "terminal_run"],
      allowedExternalSideEffectTools: [],
    });
    expect(policy.decide(tool("file_write", "config_write"), { path: "notes/report.md" }).mode).toBe("auto");
    expect(policy.decide(tool("file_write", "config_write"), { path: "src/report.md" }).mode).toBe("block");
    expect(policy.decide(tool("file_write", "config_write"), { path: "../escape.md" }).mode).toBe("block");
    expect(policy.decide(tool("terminal_run", "execute"), { command: "echo unsafe" }).mode).toBe("block");
  });

  it("rejects writes through symlinks and operations targeting a safe-root directory itself", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-policy-"));
    try {
      fs.mkdirSync(path.join(workspace, "autonomy"), { recursive: true });
      fs.mkdirSync(path.join(workspace, "packages"), { recursive: true });
      fs.symlinkSync(path.join(workspace, "packages"), path.join(workspace, "autonomy", "redirect"), "dir");
      const policy = new AutonomyPolicy({ workspaceRoot: workspace, safeWriteRoots: ["autonomy"], allowedTools: ["file_write"] });
      expect(policy.decide(tool("file_write", "config_write"), { path: "autonomy/redirect/escape.txt", content: "x" }).mode).toBe("block");
      expect(policy.decide(tool("file_write", "config_write"), { path: "autonomy", content: "x" }).mode).toBe("block");
      // On POSIX, backslash is a literal filename character, not a path separator.
      // Reject it rather than allowing policy/operation path interpretations to diverge.
      expect(policy.decide(tool("file_write", "config_write"), { path: "autonomy\\escape.txt", content: "x" }).mode).toBe("block");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("requires browser to be enabled and navigation hosts to be allowlisted", () => {
    const disabled = new AutonomyPolicy({ allowedTools: ["browser_navigate"] });
    expect(disabled.decide(tool("browser_navigate", "network"), { url: "https://example.com" }).mode).toBe("block");

    const enabled = new AutonomyPolicy({ allowBrowser: true, browserAllowedDomains: ["example.com"], allowedTools: ["browser_navigate"] });
    expect(enabled.decide(tool("browser_navigate", "network"), { url: "https://www.example.com/path" }).mode).toBe("auto");
    expect(enabled.decide(tool("browser_navigate", "network"), { url: "https://example.net" }).mode).toBe("block");
    expect(enabled.decide(tool("browser_navigate", "network"), { url: "file:///etc/passwd" }).mode).toBe("block");
  });

  it("requires an allowlisted navigation before browser interaction", () => {
    const policy = new AutonomyPolicy({
      allowBrowser: true,
      browserAllowedDomains: ["example.com"],
      allowedTools: ["browser_navigate", "browser_extract"],
    });
    expect(policy.decide(tool("browser_extract", "network"), {}).mode).toBe("block");
    expect(policy.decide(tool("browser_navigate", "network"), { url: "https://example.com" }).mode).toBe("auto");
    expect(policy.decide(tool("browser_extract", "network"), {}).mode).toBe("auto");
  });

  it("defaults to the operator profile only for descriptive compatibility and filters unsafe roots", () => {
    const policy = new AutonomyPolicy({ safeWriteRoots: ["/etc", "../x", "ok"] });
    expect(policy.describe().capabilityProfile).toBe("operator");
    expect(policy.describe().safeWriteRoots).toEqual(["ok"]);
  });
});
