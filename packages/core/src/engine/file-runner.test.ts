import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareRun, runWorkspaceFile, summarizeRun, supportedRunExtensions, buildRunEnvironment, FileRunError } from "./file-runner.js";

jest.setTimeout(20_000);

function workspace(files: Record<string, string> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "miki-run-")));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("runWorkspaceFile", () => {
  it("runs a script, captures stdout/stderr and the exit code", async () => {
    const root = workspace({ "hello.js": 'console.log("out " + process.argv.slice(2).join(","));console.error("err");' });
    const result = await runWorkspaceFile({ root, file: "hello.js", args: ["a", "b"] });
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("out a,b");
    expect(result.stderr.trim()).toBe("err");
    expect(result.file).toBe("hello.js");
    expect(summarizeRun(result)).toContain("exit code 0");
  });

  it("reports a failing script with its exit code and last error line", async () => {
    const root = workspace({ "bad.js": 'console.error("boom happened");process.exit(3);' });
    const result = await runWorkspaceFile({ root, file: "bad.js" });
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
    expect(summarizeRun(result)).toContain("code 3");
    expect(summarizeRun(result)).toContain("boom happened");
  });

  it("starts in the script's folder by default and honours a workspace cwd", async () => {
    const root = workspace({ "sub/where.js": "console.log(process.cwd());", "other/.keep": "" });
    const here = await runWorkspaceFile({ root, file: "sub/where.js" });
    expect(here.stdout.trim()).toBe(path.join(root, "sub"));
    const there = await runWorkspaceFile({ root, file: "sub/where.js", cwd: "other" });
    expect(there.stdout.trim()).toBe(path.join(root, "other"));
    await expect(runWorkspaceFile({ root, file: "sub/where.js", cwd: ".." })).rejects.toMatchObject({ code: "outside_workspace" });
  });

  it("kills a script that exceeds its time limit", async () => {
    const root = workspace({ "loop.js": "setInterval(() => {}, 1000);" });
    const started = Date.now();
    const result = await runWorkspaceFile({ root, file: "loop.js", timeoutMs: 300 });
    expect(result.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(summarizeRun(result)).toContain("time limit");
  });

  it("stops a script when the caller cancels", async () => {
    const root = workspace({ "loop.js": "setInterval(() => {}, 1000);" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await runWorkspaceFile({ root, file: "loop.js", signal: controller.signal, timeoutMs: 60_000 });
    expect(result.status).toBe("cancelled");
  });

  it("truncates large output and stops a script that floods it", async () => {
    const root = workspace({ "flood.js": 'const c="x".repeat(65536);const t=setInterval(()=>process.stdout.write(c),0);' });
    const result = await runWorkspaceFile({ root, file: "flood.js", maxOutputBytes: 4096, timeoutMs: 15_000 });
    expect(["output_limit", "timeout"]).toContain(result.status);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(4096);
  });

  it("does not leak secrets from the gateway environment", async () => {
    const root = workspace({ "env.js": "console.log(JSON.stringify({k:process.env.OPENAI_API_KEY||null,t:process.env.GITHUB_TOKEN||null,flag:process.env.MIKI_FILE_RUN,path:Boolean(process.env.PATH)}));" });
    process.env.OPENAI_API_KEY = "sk-test-secret-value-1234567890abcdef";
    process.env.GITHUB_TOKEN = "ghp_secretsecretsecretsecretsecretsecret12";
    try {
      const result = await runWorkspaceFile({ root, file: "env.js" });
      expect(JSON.parse(result.stdout)).toEqual({ k: null, t: null, flag: "1", path: true });
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("redacts credential-shaped strings printed by a script", async () => {
    const root = workspace({ "print.js": 'console.log("key=sk-abcdefghijklmnopqrstuvwxyz123456");' });
    const result = await runWorkspaceFile({ root, file: "print.js" });
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout).not.toContain("sk-abcdefghijkl");
  });

  it("passes arguments literally; shell metacharacters are not interpreted", async () => {
    const root = workspace({ "args.js": "console.log(JSON.stringify(process.argv.slice(2)));" });
    const marker = path.join(root, "pwned");
    const result = await runWorkspaceFile({ root, file: "args.js", args: [`; touch ${marker}`, "$(touch x)", "`id`"] });
    expect(JSON.parse(result.stdout)).toEqual([`; touch ${marker}`, "$(touch x)", "`id`"]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  posixOnly("runs shell scripts through bash/sh", async () => {
    const root = workspace({ "run.sh": 'echo "shell says $1"' });
    const result = await runWorkspaceFile({ root, file: "run.sh", args: ["hi"] });
    expect(result.status).toBe("ok");
    expect(result.stdout.trim()).toBe("shell says hi");
  });

  it("rejects unsupported, sensitive, missing, oversized-args and escaping files", () => {
    const root = workspace({ "data.bin": "x", "notes.txt": "x", ".env": "A=1", "ok.js": "" });
    expect(() => prepareRun({ root, file: "notes.txt" })).toThrow(/Supported types/);
    expect(() => prepareRun({ root, file: "data.bin" })).toThrow(FileRunError);
    expect(() => prepareRun({ root, file: ".env" })).toThrow(/Credential/);
    expect(() => prepareRun({ root, file: "missing.js" })).toThrow(/does not exist/);
    expect(() => prepareRun({ root, file: "../escape.js" })).toThrow(/outside the workspace/);
    expect(() => prepareRun({ root, file: "/etc/hostname" })).toThrow(/outside the workspace/);
    expect(() => prepareRun({ root, file: "ok.js", args: Array(40).fill("a") })).toThrow(/arguments/);
    expect(() => prepareRun({ root, file: "." })).toThrow(/regular files/);
  });

  posixOnly("refuses symbolic links, including links that leave the workspace", () => {
    const root = workspace({ "real.js": "console.log(1)" });
    const outside = workspace({ "evil.js": "console.log('evil')" });
    fs.symlinkSync(path.join(root, "real.js"), path.join(root, "link.js"));
    fs.symlinkSync(path.join(outside, "evil.js"), path.join(root, "evil-link.js"));
    expect(() => prepareRun({ root, file: "link.js" })).toThrow(/Symbolic links/);
    expect(() => prepareRun({ root, file: "evil-link.js" })).toThrow(/symbolic link|outside/i);
  });

  posixOnly("runs native executables only when explicitly allowed", async () => {
    const root = workspace({ "tool": "#!/bin/sh\necho native\n" });
    fs.chmodSync(path.join(root, "tool"), 0o755);
    await expect(runWorkspaceFile({ root, file: "tool" })).rejects.toMatchObject({ code: "unsupported_type" });
    const result = await runWorkspaceFile({ root, file: "tool", allowNative: true });
    expect(result.stdout.trim()).toBe("native");
  });

  it("limits concurrent runs", async () => {
    const root = workspace({ "sleep.js": "setTimeout(()=>{},1500)" });
    const runs = Array.from({ length: 5 }, () => runWorkspaceFile({ root, file: "sleep.js", timeoutMs: 5000 }).then((r) => r.status, (e: FileRunError) => e.code));
    const outcomes = await Promise.all(runs);
    expect(outcomes.filter((o) => o === "busy").length).toBeGreaterThanOrEqual(1);
    expect(outcomes).toContain("ok");
  });

  it("describes the supported types and the reduced environment", () => {
    expect(supportedRunExtensions()).toEqual(expect.arrayContaining([".js", ".py"]));
    const env = buildRunEnvironment({ PATH: "/bin", SECRET_TOKEN: "x", HOME: "/h" } as NodeJS.ProcessEnv, { EXTRA: "1" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", EXTRA: "1", MIKI_FILE_RUN: "1" });
  });
});
