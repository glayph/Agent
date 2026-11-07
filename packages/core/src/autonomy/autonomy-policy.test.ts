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

  it("enforces safe write roots and routes ungranted side effects to owner approval", () => {
    const policy = new AutonomyPolicy({
      safeWriteRoots: ["notes"],
      allowedTools: ["file_write", "terminal_run"],
      allowedExternalSideEffectTools: [],
    });
    expect(policy.decide(tool("file_write", "config_write"), { path: "notes/report.md" }).mode).toBe("auto");
    expect(policy.decide(tool("file_write", "config_write"), { path: "src/report.md" }).mode).toBe("block");
    expect(policy.decide(tool("file_write", "config_write"), { path: "../escape.md" }).mode).toBe("block");
    expect(policy.decide(tool("terminal_run", "execute"), { command: "echo unsafe" }).mode).toBe("approval");
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

  it("auto-approves high-impact actions when configured, without bypassing capability or workspace denies", () => {
    const policy = new AutonomyPolicy({
      autoApproveAll: true,
      safeWriteRoots: ["notes"],
      allowedTools: ["terminal_run", "file_delete"],
      allowedExternalSideEffectTools: [],
    });
    expect(policy.decide(tool("terminal_run", "execute"), { command: "sudo rm -rf /" }).mode).toBe("auto");
    expect(policy.decide(tool("file_delete", "destructive"), { path: "notes/old.txt" }).mode).toBe("auto");
    expect(policy.decide(tool("file_delete", "destructive"), { path: "../outside.txt" }).mode).toBe("block");
    expect(policy.decide(tool("computer_launch", "execute"), {}).mode).toBe("block");
  });

  it("lets the workspace wildcard cover every relative workspace folder but not symlink escapes", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-policy-wildcard-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "miki-policy-outside-"));
    try {
      fs.mkdirSync(path.join(workspace, "deep", "nested"), { recursive: true });
      fs.symlinkSync(outside, path.join(workspace, "redirect"), "dir");
      const policy = new AutonomyPolicy({
        workspaceRoot: workspace,
        safeWriteRoots: ["*"],
        autoApproveAll: true,
        allowedTools: ["file_write", "file_move"],
      });
      expect(policy.decide(tool("file_write", "config_write"), { path: "deep/nested/report.md" }).mode).toBe("auto");
      expect(policy.decide(tool("file_move", "destructive"), { path: "deep/a.txt", destination: "deep/nested/b.txt" }).mode).toBe("auto");
      expect(policy.decide(tool("file_write", "config_write"), { path: "../outside.md" }).mode).toBe("block");
      expect(policy.decide(tool("file_write", "config_write"), { path: "redirect/outside.md" }).mode).toBe("block");
      expect(policy.decide(tool("file_write", "config_write"), { path: "/etc/passwd" }).mode).toBe("block");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows any guest-visible file path only when full path access is explicitly enabled in no-confirm mode", () => {
    const policy = new AutonomyPolicy({
      autoApproveAll: true,
      allowAllPaths: true,
      safeWriteRoots: ["notes"],
      allowedTools: ["file_write", "file_delete"],
    });
    expect(policy.decide(tool("file_write", "config_write"), { path: "/tmp/guest-build/output.txt" }).mode).toBe("auto");
    expect(policy.decide(tool("file_delete", "destructive"), { path: "/var/tmp/guest-output.txt" }).mode).toBe("auto");

    const disabled = new AutonomyPolicy({
      autoApproveAll: false,
      allowAllPaths: true,
      safeWriteRoots: ["notes"],
      allowedTools: ["file_write"],
    });
    expect(disabled.decide(tool("file_write", "config_write"), { path: "/tmp/guest-build/output.txt" }).mode).toBe("block");
  });

  it("requires browser to be enabled and navigation hosts to be allowlisted", () => {
    const disabled = new AutonomyPolicy({ allowedTools: ["browser_navigate"] });
    expect(disabled.decide(tool("browser_navigate", "network"), { url: "https://example.com" }).mode).toBe("block");

    const enabled = new AutonomyPolicy({ allowBrowser: true, browserAllowedDomains: ["example.com"], allowedTools: ["browser_navigate"] });
    expect(enabled.decide(tool("browser_navigate", "network"), { url: "https://www.example.com/path" }).mode).toBe("auto");
    expect(enabled.decide(tool("browser_navigate", "network"), { url: "https://example.net" }).mode).toBe("block");
    expect(enabled.decide(tool("browser_navigate", "network"), { url: "file:///etc/passwd" }).mode).toBe("block");
  });

  it("allows any HTTP(S) hostname under the wildcard while still rejecting non-web schemes", () => {
    const policy = new AutonomyPolicy({
      autoApproveAll: true,
      allowBrowser: true,
      browserAllowedDomains: ["*"],
      allowedTools: ["browser_navigate"],
    });
    expect(policy.decide(tool("browser_navigate", "network"), { url: "https://example.net/path" }).mode).toBe("auto");
    expect(policy.decide(tool("browser_navigate", "network"), { url: "file:///etc/passwd" }).mode).toBe("block");
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

  it("requires owner approval for sensitive shell, browser, and computer actions while allowing routine tools", () => {
    const policy = new AutonomyPolicy({
      allowBrowser: true,
      browserAllowedDomains: ["example.com"],
      allowComputerUse: true,
      allowedTools: ["terminal_run", "browser_navigate", "browser_click", "computer_set_text"],
      allowedExternalSideEffectTools: ["terminal_run", "browser_click", "computer_set_text"],
    });
    expect(policy.decide(tool("terminal_run", "execute"), { command: "npm test" }).mode).toBe("auto");
    expect(policy.decide(tool("terminal_run", "execute"), { command: "sudo passwd user" }).mode).toBe("approval");
    expect(policy.decide(tool("browser_navigate", "network"), { url: "https://example.com" }).mode).toBe("auto");
    expect(policy.decide(tool("browser_click", "network"), { label: "Buy now" }).mode).toBe("approval");
    expect(policy.decide(tool("computer_set_text", "config_write"), { text: "send payment" }).mode).toBe("approval");
  });

  it("keeps ordinary plugin calls autonomous while escalating sensitive plugin methods", () => {
    const policy = new AutonomyPolicy({
      allowedTools: ["plugin_invoke"],
      allowedExternalSideEffectTools: ["plugin_invoke"],
    });
    expect(policy.decide(tool("plugin_invoke", "config_write"), { method: "notes.search", payload: { query: "meeting" } }).mode).toBe("auto");
    expect(policy.decide(tool("plugin_invoke", "config_write"), { method: "messages.send", payload: { to: "owner", text: "hello" } }).mode).toBe("approval");
    expect(policy.decide(tool("plugin_invoke", "install"), { method: "tools.install", payload: {} }).mode).toBe("approval");
  });

  it("defaults to the operator profile only for descriptive compatibility and filters unsafe roots", () => {
    const policy = new AutonomyPolicy({ safeWriteRoots: ["/etc", "../x", "ok"] });
    expect(policy.describe().capabilityProfile).toBe("operator");
    expect(policy.describe().safeWriteRoots).toEqual(["ok"]);
  });
});
