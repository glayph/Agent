import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSecurityExecutor } from "./file-security.js";

function mkTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-fs-workspace-"));
}

function makeExecutor(workspace: string): FileSecurityExecutor {
  // No config/tools.yaml at this path -> loadConfig() returns {} -> every
  // tool is allowed, so these tests isolate the SOUL guard specifically
  // rather than the separate permissions system.
  const executor = new FileSecurityExecutor(
    path.join(workspace, "config", "tools.yaml"),
  );
  executor.setWorkspaceRoot(workspace);
  return executor;
}

describe("FileSecurityExecutor SOUL.md protection", () => {
  it("refuses to overwrite SOUL.md even though file_write is otherwise allowed", () => {
    const workspace = mkTempWorkspace();
    const identityDir = path.join(workspace, "identity");
    fs.mkdirSync(identityDir, { recursive: true });
    fs.writeFileSync(path.join(identityDir, "SOUL.md"), "core values");

    const executor = makeExecutor(workspace);
    executor.setIdentityDir(identityDir);

    const result = executor.writeFile(
      "identity/SOUL.md",
      "overwritten by agent",
    );
    expect(result).toMatch(/read-only/i);
    expect(fs.readFileSync(path.join(identityDir, "SOUL.md"), "utf-8")).toBe(
      "core values",
    );
  });

  it("refuses to delete SOUL.md", () => {
    const workspace = mkTempWorkspace();
    const identityDir = path.join(workspace, "identity");
    fs.mkdirSync(identityDir, { recursive: true });
    fs.writeFileSync(path.join(identityDir, "SOUL.md"), "core values");

    const executor = makeExecutor(workspace);
    executor.setIdentityDir(identityDir);

    const result = executor.deleteFile("identity/SOUL.md");
    expect(result).toMatch(/read-only/i);
    expect(fs.existsSync(path.join(identityDir, "SOUL.md"))).toBe(true);
  });

  it("still allows writing other identity files, like AGENTS.md", () => {
    const workspace = mkTempWorkspace();
    const identityDir = path.join(workspace, "identity");
    fs.mkdirSync(identityDir, { recursive: true });

    const executor = makeExecutor(workspace);
    executor.setIdentityDir(identityDir);

    const result = executor.writeFile("identity/AGENTS.md", "new rule");
    expect(result).toMatch(/^Success/);
    expect(fs.readFileSync(path.join(identityDir, "AGENTS.md"), "utf-8")).toBe(
      "new rule",
    );
  });

  it("does not protect anything when setIdentityDir was never called", () => {
    const workspace = mkTempWorkspace();
    fs.mkdirSync(path.join(workspace, "identity"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "identity", "SOUL.md"),
      "core values",
    );

    const executor = makeExecutor(workspace);
    // setIdentityDir intentionally not called.
    const result = executor.writeFile("identity/SOUL.md", "overwritten");
    expect(result).toMatch(/^Success/);
  });
});
