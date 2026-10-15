import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFileManagementTools } from "./file-tools.js";
import type { ToolExecutionContext } from "./types.js";

jest.setTimeout(20_000);
const ctx = (): ToolExecutionContext => ({ runId: "r1", callId: "c1", signal: new AbortController().signal });

function setup(options: { executionEnabled?: () => boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "miki-ft-")));
  fs.mkdirSync(path.join(root, "src/deep"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.txt"), "A");
  fs.writeFileSync(path.join(root, "src/deep/b.txt"), "B");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(root, "job.js"), 'console.log("job done", process.argv[2] ?? "")');
  const runs: unknown[] = [];
  const tools = Object.fromEntries(createFileManagementTools({ root, onRun: (e) => runs.push(e), ...options }).map((t) => [t.name, t]));
  const call = async (name: string, input: Record<string, unknown>) => tools[name].execute(input, ctx());
  return { root, tools, call, runs };
}

describe("file management tools", () => {
  it("declares risk and approval so the engine gates the dangerous ones", () => {
    const { tools } = setup();
    expect(tools.file_info.risk).toBe("read");
    expect(tools.file_delete).toMatchObject({ risk: "destructive", approval: "required" });
    expect(tools.file_run).toMatchObject({ risk: "service", approval: "required" });
    for (const name of ["file_mkdir", "file_rename", "file_move", "file_copy"]) expect(tools[name].risk).toBe("config_write");
  });

  it("describes files and folders", async () => {
    const { call } = setup();
    expect(await call("file_info", { path: "src/a.txt" })).toMatchObject({ type: "file", sizeBytes: 1, extension: "txt", runnable: false });
    expect(await call("file_info", { path: "job.js" })).toMatchObject({ runnable: true });
    expect(await call("file_info", { path: "src" })).toMatchObject({ type: "directory" });
    await expect(call("file_info", { path: "nope" })).rejects.toThrow("does not exist");
  });

  it("creates folders idempotently", async () => {
    const { root, call } = setup();
    expect(await call("file_mkdir", { path: "x/y/z" })).toEqual({ path: path.join("x", "y", "z"), created: true });
    expect(fs.statSync(path.join(root, "x/y/z")).isDirectory()).toBe(true);
    expect(await call("file_mkdir", { path: "x/y/z" })).toMatchObject({ created: false });
    await expect(call("file_mkdir", { path: "src/a.txt" })).rejects.toThrow("already exists");
  });

  it("renames within a folder and rejects slashes and collisions", async () => {
    const { root, call } = setup();
    await call("file_rename", { path: "src/a.txt", newName: "renamed.txt" });
    expect(fs.existsSync(path.join(root, "src/renamed.txt"))).toBe(true);
    await expect(call("file_rename", { path: "src/renamed.txt", newName: "../x" })).rejects.toThrow("plain file name");
    await expect(call("file_rename", { path: "src/renamed.txt", newName: "deep" })).rejects.toThrow("already exists");
    await expect(call("file_rename", { path: "src/renamed.txt", newName: ".env" })).rejects.toThrow("blocked");
  });

  it("copies folders recursively and moves files without overwriting", async () => {
    const { root, call } = setup();
    fs.mkdirSync(path.join(root, "dest"));
    await call("file_copy", { path: "src", destination: "dest" });
    expect(fs.readFileSync(path.join(root, "dest/src/deep/b.txt"), "utf8")).toBe("B");
    expect(fs.existsSync(path.join(root, "src/deep/b.txt"))).toBe(true);
    await expect(call("file_copy", { path: "src", destination: "dest" })).rejects.toThrow("already exists");
    await call("file_move", { path: "src/a.txt", destination: "dest" });
    expect(fs.existsSync(path.join(root, "src/a.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "dest/a.txt"), "utf8")).toBe("A");
    await call("file_move", { path: "dest/a.txt", destination: "moved.txt" });
    expect(fs.existsSync(path.join(root, "moved.txt"))).toBe(true);
  });

  it("blocks moving a folder into itself, touching the root, secrets and escapes", async () => {
    const { root, call } = setup();
    await expect(call("file_move", { path: "src", destination: "src/deep" })).rejects.toThrow("into itself");
    await expect(call("file_copy", { path: "src", destination: "src/deep" })).rejects.toThrow("into itself");
    await expect(call("file_move", { path: ".", destination: "elsewhere" })).rejects.toThrow("root cannot be modified");
    await expect(call("file_delete", { path: ".", recursive: true })).rejects.toThrow("root cannot be modified");
    await expect(call("file_copy", { path: ".env", destination: "copy.txt" })).rejects.toThrow("blocked");
    await expect(call("file_copy", { path: "src/a.txt", destination: "../outside.txt" })).rejects.toThrow("outside the workspace");
    expect(fs.readdirSync(path.dirname(root)).includes("outside.txt")).toBe(false);
  });

  it("refuses to copy trees that contain symlinks", async () => {
    if (process.platform === "win32") return;
    const { root, call } = setup();
    fs.symlinkSync("/etc", path.join(root, "src/etc-link"));
    await expect(call("file_copy", { path: "src", destination: "copy" })).rejects.toThrow("Symbolic links");
    expect(fs.existsSync(path.join(root, "copy"))).toBe(false);
  });

  it("deletes files, and folders only with recursive=true", async () => {
    const { root, call } = setup();
    await expect(call("file_delete", { path: "src" })).rejects.toThrow("recursive=true");
    expect(await call("file_delete", { path: "src", recursive: true })).toMatchObject({ deleted: true, entriesRemoved: 4 });
    expect(fs.existsSync(path.join(root, "src"))).toBe(false);
    await call("file_delete", { path: "job.js" });
    expect(fs.existsSync(path.join(root, "job.js"))).toBe(false);
    await expect(call("file_delete", { path: ".env" })).rejects.toThrow("blocked");
  });

  it("runs scripts and records the audit callback", async () => {
    const { call, runs } = setup();
    const result = (await call("file_run", { path: "job.js", args: ["now"] })) as { status: string; stdout: string };
    expect(result.status).toBe("ok");
    expect(result.stdout.trim()).toBe("job done now");
    expect(runs).toEqual([expect.objectContaining({ file: "job.js", args: ["now"], status: "ok", exitCode: 0, runId: "r1" })]);
  });

  it("surfaces run errors with their code and honours the kill switch", async () => {
    const { call } = setup();
    await expect(call("file_run", { path: ".env" })).rejects.toThrow("sensitive_file");
    await expect(call("file_run", { path: "src/a.txt" })).rejects.toThrow("unsupported_type");
    const off = setup({ executionEnabled: () => false });
    await expect(off.call("file_run", { path: "job.js" })).rejects.toThrow("disabled");
  });

  it("honors dynamic workspace roots and trusted absolute paths when unrestricted", async () => {
    const rootA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "miki-ft-a-")));
    const rootB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "miki-ft-b-")));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "miki-ft-out-")));
    fs.writeFileSync(path.join(rootB, "b.txt"), "B");
    fs.writeFileSync(path.join(outside, "c.txt"), "C");
    let root = rootA;
    let restricted = true;
    const tools = Object.fromEntries(createFileManagementTools({ root: () => root, restrictToWorkspace: () => restricted }).map((t) => [t.name, t]));
    await expect(tools.file_read.execute({ path: "b.txt" }, ctx())).rejects.toThrow("does not exist");
    root = rootB;
    await expect(tools.file_read.execute({ path: "b.txt" }, ctx())).resolves.toMatchObject({ content: "B" });
    restricted = false;
    await expect(tools.file_read.execute({ path: path.join(outside, "c.txt") }, ctx())).resolves.toMatchObject({ content: "C" });
  });

  it("passes the workspace restriction through to script execution", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "miki-ft-run-root-")));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "miki-ft-run-out-")));
    const script = path.join(outside, "outside.js");
    fs.writeFileSync(script, 'console.log("outside-ok")');
    const tools = Object.fromEntries(createFileManagementTools({ root, restrictToWorkspace: false }).map((t) => [t.name, t]));
    const result = await tools.file_run.execute({ path: script }, ctx()) as { stdout: string };
    expect(result.stdout.trim()).toBe("outside-ok");
  });
});
