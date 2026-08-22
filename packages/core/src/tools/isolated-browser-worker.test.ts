import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalInbox } from "../security/approval-inbox.js";
import { IsolatedBrowserWorker } from "./isolated-browser-worker.js";

const FAKE_BROWSER_MODULE = `
export class BrowserTool {
  constructor() {}
  async getUrl() { return 'https://worker.local/'; }
  async navigate(url) { return 'navigated:' + url; }
  async close() { return 'closed'; }
}
`;

describe("IsolatedBrowserWorker", () => {
  it("runs commands in a separate child process with a per-run profile", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-browser-worker-"),
    );
    const modulePath = path.join(directory, "fake-browser.mjs");
    fs.writeFileSync(modulePath, FAKE_BROWSER_MODULE, "utf8");
    const worker = new IsolatedBrowserWorker({
      dataDir: directory,
      runId: "run-isolated",
      browserModulePath: modulePath,
      retainProfile: false,
    });

    await expect(worker.execute({ command: "getUrl" })).resolves.toBe(
      "https://worker.local/",
    );
    expect(worker.pid).toBeTypeOf("number");
    expect(worker.profilePath).toContain(
      path.join("browser-runs", "run-isolated"),
    );
    await worker.close();
    expect(fs.existsSync(worker.profilePath)).toBe(false);
  });

  it("blocks a browser side effect until the approval inbox records an approval", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-browser-approval-"),
    );
    const modulePath = path.join(directory, "fake-browser.mjs");
    fs.writeFileSync(modulePath, FAKE_BROWSER_MODULE, "utf8");
    const inbox = new ApprovalInbox(path.join(directory, "approvals.json"));
    const challenge = inbox.request({
      runId: "run-side-effect",
      actor: "agent",
      action: "external_write",
      resource: "crm:1",
      risk: "high",
      reason: "sync",
    });
    const worker = new IsolatedBrowserWorker({
      dataDir: directory,
      browserModulePath: modulePath,
      approvalInbox: inbox,
    });

    await expect(
      worker.execute({
        command: "navigate",
        args: { url: "https://example.test" },
        action: "external_write",
      }),
    ).rejects.toThrow(/Human approval/);
    await inbox.approveByOperator(
      challenge.request.id,
      "operator",
      "confirmed",
    );
    await expect(
      worker.execute({
        command: "navigate",
        args: { url: "https://example.test" },
        action: "external_write",
        approvalRequestId: challenge.request.id,
        approvalToken: challenge.token,
      }),
    ).resolves.toBe("navigated:https://example.test");
    await worker.close();
  });
});
