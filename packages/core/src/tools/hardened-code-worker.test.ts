import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HardenedCodeWorker } from "./hardened-code-worker.js";

describe("HardenedCodeWorker", () => {
  it("runs an allowlisted command inside the workspace", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "miki-code-worker-"),
    );
    const worker = new HardenedCodeWorker({ workspaceDir: workspace });
    const result = await worker.run(process.execPath, [
      "-e",
      "process.stdout.write('ok')",
    ]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("ok");
    expect(result.cwd).toBe(workspace);
  });

  it("blocks dangerous and non-allowlisted commands", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "miki-code-worker-"),
    );
    const worker = new HardenedCodeWorker({ workspaceDir: workspace });
    await expect(worker.run("sudo", ["echo", "bad"])).resolves.toMatchObject({
      status: "blocked",
    });
    await expect(
      worker.run("bash", ["-lc", "echo bad"]),
    ).resolves.toMatchObject({ status: "blocked" });
  });

  it("rejects a cwd outside the configured workspace", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "miki-code-worker-"),
    );
    const worker = new HardenedCodeWorker({ workspaceDir: workspace });
    await expect(
      worker.run(process.execPath, ["-e", ""], { cwd: ".." }),
    ).rejects.toThrow(/workspace/);
  });

  it("times out long-running commands", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "miki-code-worker-"),
    );
    const worker = new HardenedCodeWorker({
      workspaceDir: workspace,
      defaultTimeoutMs: 1000,
    });
    const result = await worker.run(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      { timeoutMs: 1000 },
    );
    expect(result.status).toBe("timed_out");
    expect(result.ok).toBe(false);
  });

  it("redacts common secrets from command output", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "miki-code-worker-"),
    );
    const worker = new HardenedCodeWorker({ workspaceDir: workspace });
    const secret = ["AIza", "SyDUMMY012345678901234567890"].join("");
    await writeFile(path.join(workspace, "marker.txt"), secret);
    const result = await worker.run(process.execPath, [
      "-e",
      `process.stdout.write(${JSON.stringify(`api_key=${secret}`)})`,
    ]);
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.redactions).toBeGreaterThan(0);
  });
});
