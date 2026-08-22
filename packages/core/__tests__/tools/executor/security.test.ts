import fs from "fs";
import path from "path";
import os from "os";
import { ShellExecutor } from "../../../src/tools/executor/shell.js";
import { FileSecurityExecutor } from "../../../src/tools/executor/file-security.js";
import { runWithCallOrigin } from "../../../src/tools/executor/call-context.js";

function writeConfig(dir: string, content: string): string {
  const configPath = path.join(dir, "tools.yaml");
  fs.writeFileSync(configPath, content, "utf-8");
  return configPath;
}

describe("tool executor security", () => {
  it("rejects shell metacharacters when disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-shell-"));
    const configPath = writeConfig(
      dir,
      ["permissions:", "  shell_execute:", "    level: DISABLED"].join("\n"),
    );
    const executor = new ShellExecutor(configPath);

    const result = await executor.runShell("node -v && echo bypass", dir, 5);

    expect(result.exitCode).toBe(-1);
    expect(result.error).toContain("disabled");
  });

  it("allows shell execution outside any workspace in trusted full-access mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-shell-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-outside-"));
    const configPath = writeConfig(
      dir,
      [
        "permissions:",
        "  shell_execute:",
        "    level: TRUSTED_FULL_ACCESS",
        "    workspace_only: false",
      ].join("\n"),
    );
    const executor = new ShellExecutor(configPath);

    const result = await executor.runShell(
      process.platform === "win32" ? "cd" : "pwd",
      outsideDir,
      5,
    );

    expect(result.exitCode).toBe(0);
    expect(path.resolve(result.stdout.trim())).toBe(path.resolve(outsideDir));
  });

  it("enforces max_file_size_mb for file reads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-file-"));
    const configPath = writeConfig(
      dir,
      [
        "permissions:",
        "  file_read:",
        "    level: TRUSTED_FULL_ACCESS",
        "    max_file_size_mb: 0",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(dir, "large.txt"), "x", "utf-8");
    const executor = new FileSecurityExecutor(configPath);

    expect(executor.readFile(path.join(dir, "large.txt"))).toContain(
      "max_file_size_mb",
    );
  });

  it("allows absolute file paths anywhere on the filesystem", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-file-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-outside-"));
    const outsidePath = path.join(outsideDir, "outside.txt");
    fs.writeFileSync(outsidePath, "outside-content", "utf-8");
    const configPath = writeConfig(
      dir,
      [
        "permissions:",
        "  file_read:",
        "    level: TRUSTED_FULL_ACCESS",
        "    workspace_only: false",
        "    allow_absolute_paths: true",
      ].join("\n"),
    );
    const executor = new FileSecurityExecutor(configPath);

    expect(executor.readFile(outsidePath)).toBe("outside-content");
  });

  it("allows file access via symlinks (no workspace restriction)", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-file-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-outside-"));
    fs.writeFileSync(path.join(outsideDir, "outside.txt"), "outside", "utf-8");
    const linkPath = path.join(workspaceDir, "outside-link");
    try {
      fs.symlinkSync(outsideDir, linkPath, "junction");
    } catch {
      return;
    }
    const configPath = writeConfig(
      workspaceDir,
      [
        "permissions:",
        "  file_read:",
        "    level: TRUSTED_FULL_ACCESS",
        "  file_write:",
        "    level: TRUSTED_FULL_ACCESS",
      ].join("\n"),
    );
    const executor = new FileSecurityExecutor(configPath);

    expect(executor.readFile(path.join(linkPath, "outside.txt"))).not.toContain(
      "Error:",
    );
    expect(executor.writeFile(path.join(linkPath, "new.txt"), "x")).toContain(
      "Success:",
    );
  });
});

describe("runtime.exec.allow_remote enforcement (#94)", () => {
  it("blocks shell execution from a remote-origin caller when allow_remote is false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-shell-remote-"));
    const configPath = writeConfig(
      dir,
      [
        "permissions:",
        "  shell_execute:",
        "    level: TRUSTED_FULL_ACCESS",
        "runtime:",
        "  exec:",
        "    allow_remote: false",
      ].join("\n"),
    );
    const executor = new ShellExecutor(configPath);

    const result = await runWithCallOrigin("remote", () =>
      executor.runShell(process.platform === "win32" ? "cd" : "pwd", dir, 5),
    );

    expect(result.exitCode).toBe(-1);
    expect(result.error).toContain("allow_remote");
  });

  it("allows shell execution from a local-origin caller when allow_remote is false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-shell-local-"));
    const configPath = writeConfig(
      dir,
      [
        "permissions:",
        "  shell_execute:",
        "    level: TRUSTED_FULL_ACCESS",
        "runtime:",
        "  exec:",
        "    allow_remote: false",
      ].join("\n"),
    );
    const executor = new ShellExecutor(configPath);

    const result = await runWithCallOrigin("local", () =>
      executor.runShell(process.platform === "win32" ? "cd" : "pwd", dir, 5),
    );

    expect(result.exitCode).toBe(0);
  });

  it("treats an unestablished call origin as local (fail-open for unwired paths)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-shell-noctx-"));
    const configPath = writeConfig(
      dir,
      [
        "permissions:",
        "  shell_execute:",
        "    level: TRUSTED_FULL_ACCESS",
        "runtime:",
        "  exec:",
        "    allow_remote: false",
      ].join("\n"),
    );
    const executor = new ShellExecutor(configPath);

    // No runWithCallOrigin wrapper at all -- simulates a call path (MCP,
    // channel-origin) this fix does not yet establish an origin for.
    const result = await executor.runShell(
      process.platform === "win32" ? "cd" : "pwd",
      dir,
      5,
    );

    expect(result.exitCode).toBe(0);
  });

  it("allows remote execution when allow_remote is true (default)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-shell-default-"));
    const configPath = writeConfig(
      dir,
      [
        "permissions:",
        "  shell_execute:",
        "    level: TRUSTED_FULL_ACCESS",
      ].join("\n"),
    );
    const executor = new ShellExecutor(configPath);

    const result = await runWithCallOrigin("remote", () =>
      executor.runShell(process.platform === "win32" ? "cd" : "pwd", dir, 5),
    );

    expect(result.exitCode).toBe(0);
  });
});
