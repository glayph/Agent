import fs from "fs";
import path from "path";
import os from "os";
import { ShellExecutor } from "./shell.js";
import { FileSecurityExecutor } from "./file-security.js";
import { runWithCallOrigin } from "./call-context.js";

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

    // No runWithCallOrigin wrapper at all -- simulates an internal/local
    // path that has not established an explicit caller origin.
    const result = await executor.runShell(
      process.platform === "win32" ? "cd" : "pwd",
      dir,
      5,
    );

    expect(result.exitCode).toBe(0);
  });

  it("blocks remote file mutations when allow_remote is false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-file-remote-"));
    const configPath = writeConfig(
      dir,
      [
        "permissions:",
        "  file_write:",
        "    level: TRUSTED_FULL_ACCESS",
        "    allow_remote: false",
        "  file_delete:",
        "    level: TRUSTED_FULL_ACCESS",
        "    allow_remote: false",
      ].join("\\n"),
    );
    const executor = new FileSecurityExecutor(configPath);
    executor.setWorkspaceRoot(dir);
    const target = path.join(dir, "remote.txt");

    expect(
      runWithCallOrigin("remote", () => executor.writeFile(target, "blocked")),
    ).toContain("allow_remote");
    expect(fs.existsSync(target)).toBe(false);

    fs.writeFileSync(target, "keep", "utf8");
    expect(
      runWithCallOrigin("remote", () => executor.deleteFile(target)),
    ).toContain("allow_remote");
    expect(fs.existsSync(target)).toBe(true);
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

describe("active workspace boundary", () => {
  it("resolves relative file operations inside the active workspace and rejects outside paths", () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-workspace-"),
    );
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-outside-"));
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
    executor.setWorkspaceRoot(workspaceDir);

    expect(executor.writeFile("generated/result.txt", "ok")).toContain(
      "Success:",
    );
    expect(
      fs.readFileSync(path.join(workspaceDir, "generated/result.txt"), "utf8"),
    ).toBe("ok");
    expect(
      executor.writeFile(path.join(outsideDir, "blocked.txt"), "nope"),
    ).toContain("inside the active workspace");
  });

  it("uses the active workspace as shell default cwd and rejects outside cwd", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-shell-workspace-"),
    );
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-shell-outside-"),
    );
    const configPath = writeConfig(
      workspaceDir,
      [
        "permissions:",
        "  shell_execute:",
        "    level: TRUSTED_FULL_ACCESS",
      ].join("\n"),
    );
    const executor = new ShellExecutor(configPath);
    executor.setWorkspaceRoot(workspaceDir);

    const defaultCwd = await executor.runShell(
      process.platform === "win32" ? "cd" : "pwd",
      undefined,
      5,
    );
    expect(defaultCwd.exitCode).toBe(0);
    expect(path.resolve(defaultCwd.stdout.trim())).toBe(
      path.resolve(workspaceDir),
    );

    const blocked = await executor.runShell(
      process.platform === "win32" ? "cd" : "pwd",
      outsideDir,
      5,
    );
    expect(blocked.exitCode).toBe(-1);
    expect(blocked.error).toContain("inside the active workspace");
  });
});

describe("symlink-aware workspace boundary", () => {
  it("rejects file operations through a workspace symlink to an outside directory", () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-symlink-workspace-"),
    );
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-symlink-outside-"),
    );
    const configPath = writeConfig(
      workspaceDir,
      "permissions:\n  file_write:\n    level: TRUSTED_FULL_ACCESS\n",
    );
    const linkPath = path.join(workspaceDir, "linked");
    try {
      fs.symlinkSync(outsideDir, linkPath, "junction");
    } catch {
      return;
    }
    const executor = new FileSecurityExecutor(configPath);
    executor.setWorkspaceRoot(workspaceDir);
    expect(executor.writeFile("linked/escaped.txt", "outside")).toContain(
      "inside the active workspace",
    );
    expect(fs.existsSync(path.join(outsideDir, "escaped.txt"))).toBe(false);
  });

  it("rejects a symlinked shell cwd outside the active workspace", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-shell-symlink-workspace-"),
    );
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-shell-symlink-outside-"),
    );
    const configPath = writeConfig(
      workspaceDir,
      "permissions:\n  shell_execute:\n    level: TRUSTED_FULL_ACCESS\n",
    );
    const linkPath = path.join(workspaceDir, "linked");
    try {
      fs.symlinkSync(outsideDir, linkPath, "junction");
    } catch {
      return;
    }
    const executor = new ShellExecutor(configPath);
    executor.setWorkspaceRoot(workspaceDir);
    const result = await executor.runShell(
      process.platform === "win32" ? "cd" : "pwd",
      linkPath,
      5,
    );
    expect(result.exitCode).toBe(-1);
    expect(result.error).toContain("inside the active workspace");
  });
});
