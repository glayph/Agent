import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectArtifactContract,
  reconcileArtifactOutcome,
  verifyArtifactContract,
} from "./artifact-contract.js";
import { PersistentJobQueue } from "../persistent-job-queue.js";

describe("artifact contract", () => {
  it("detects Bengali landing-page intent and roots it in the workspace", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-artifact-"));
    const contract = detectArtifactContract(
      "আমার workspace-এ একটি responsive ল্যান্ডিং পেজ তৈরি করো",
      workspace,
    );

    expect(contract?.root).toBe(path.resolve(workspace));
    expect(contract?.required).toEqual(["index.html"]);
  });

  it("detects and verifies generic exact file workflows", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-files-"));
    const content =
      "Create multi-one.txt containing exactly one; create multi-two.txt containing exactly two; then verify both files.";
    const contract = detectArtifactContract(content, workspace);
    expect(contract).toEqual({
      root: path.resolve(workspace),
      required: ["multi-one.txt", "multi-two.txt"],
      label: "file workflow",
    });
    expect(verifyArtifactContract(contract!)).toEqual({
      ok: false,
      missing: ["multi-one.txt", "multi-two.txt"],
      invalid: [],
    });
    fs.writeFileSync(path.join(workspace, "multi-one.txt"), "one", "utf8");
    fs.writeFileSync(path.join(workspace, "multi-two.txt"), "two", "utf8");
    expect(verifyArtifactContract(contract!)).toEqual({
      ok: true,
      missing: [],
      invalid: [],
    });
  });

  it("reconciles a verified artifact with a provider warning", () => {
    expect(
      reconcileArtifactOutcome({ ok: true, missing: [], invalid: [] }, true),
    ).toBe("completed_with_warning");
    expect(
      reconcileArtifactOutcome({ ok: true, missing: [], invalid: [] }, false),
    ).toBe("completed");
    expect(
      reconcileArtifactOutcome(
        { ok: false, missing: ["index.html"], invalid: [] },
        true,
      ),
    ).toBe("failed");
  });

  it("preserves artifact verification evidence across a queue restart", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-replay-"));
    const queuePath = path.join(workspace, "runtime-jobs.json");
    fs.writeFileSync(
      path.join(workspace, "index.html"),
      "<!doctype html><html><body><main>Agent Miki evidence</main></body></html>",
      "utf8",
    );
    const contract = detectArtifactContract("build a landing page", workspace);
    expect(contract).not.toBeNull();

    const first = new PersistentJobQueue(queuePath);
    const job = first.enqueue(
      "agent.run",
      { artifactRoot: workspace },
      { idempotencyKey: "artifact-evidence-1" },
    );
    expect(first.dequeue(Date.now(), "worker-a")?.id).toBe(job.id);
    expect(
      first.checkpoint(
        job.id,
        {
          id: "artifact-written",
          step: "artifact-written",
          status: "completed",
          data: { files: ["index.html"] },
        },
        "worker-a",
      )?.checkpoint?.id,
    ).toBe("artifact-written");

    const restarted = new PersistentJobQueue(queuePath);
    const resumed = restarted.get(job.id);
    expect(resumed?.checkpoint?.step).toBe("artifact-written");
    const verification = verifyArtifactContract(contract!);
    expect(verification).toEqual({ ok: true, missing: [], invalid: [] });
    expect(
      restarted.complete(
        job.id,
        { artifactVerified: verification.ok, status: "completed" },
        "worker-a",
      )?.result,
    ).toEqual({ artifactVerified: true, status: "completed" });
  });

  it("does not report an empty or invalid index as completed", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-artifact-"));
    fs.writeFileSync(path.join(workspace, "index.html"), "placeholder", "utf8");
    const contract = {
      root: workspace,
      required: ["index.html"],
      label: "landing page",
    };

    expect(verifyArtifactContract(contract)).toEqual({
      ok: false,
      missing: [],
      invalid: ["index.html"],
    });
  });
});
