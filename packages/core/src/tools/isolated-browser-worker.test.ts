import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { ApprovalInbox } from "../security/approval-inbox.js";
import { IsolatedBrowserWorker } from "./isolated-browser-worker.js";

const FAKE_BROWSER_MODULE = `
export class BrowserTool {
  constructor() {}
  async getUrl() { return 'https://worker.local/'; }
  async navigate(url) { return 'navigated:' + url; }
  async playMedia(url) { return JSON.stringify({ verified: true, media: { tag: 'video', src: url, readyState: 4, paused: false, duration: 5 } }); }
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
    expect(typeof worker.pid).toBe("number");
    expect(worker.profilePath).toContain(
      path.join("browser-runs", "run-isolated"),
    );
    await worker.close();
    expect(fs.existsSync(worker.profilePath)).toBe(false);
  });

  it("forwards playMedia and preserves the verified JSON result", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-browser-media-worker-"),
    );
    const modulePath = path.join(directory, "fake-browser.mjs");
    fs.writeFileSync(modulePath, FAKE_BROWSER_MODULE, "utf8");
    const worker = new IsolatedBrowserWorker({
      dataDir: directory,
      runId: "run-media",
      browserModulePath: modulePath,
      retainProfile: false,
    });

    const result = await worker.execute({
      command: "playMedia",
      args: { url: "https://media.test/flower.mp4" },
    });
    expect(JSON.parse(String(result))).toMatchObject({
      verified: true,
      media: {
        tag: "video",
        src: "https://media.test/flower.mp4",
        readyState: 4,
        paused: false,
      },
    });
    await worker.close();
  });

  // Turbo mode has been the sole, permanent runtime mode since standard mode
  // was removed (owner-requested) — isolated-browser-worker.ts bypasses the
  // approval-inbox check unconditionally whenever it's active, so a browser
  // side effect now runs immediately with only a console.warn audit trail,
  // regardless of whether an approvalInbox is even wired up.
  it("turbo mode auto-approves a browser side effect immediately, without ever touching the approval inbox", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-browser-approval-"),
    );
    const modulePath = path.join(directory, "fake-browser.mjs");
    fs.writeFileSync(modulePath, FAKE_BROWSER_MODULE, "utf8");
    const inbox = new ApprovalInbox(path.join(directory, "approvals.json"));
    const worker = new IsolatedBrowserWorker({
      dataDir: directory,
      browserModulePath: modulePath,
      approvalInbox: inbox,
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      worker.execute({
        command: "navigate",
        args: { url: "https://example.test" },
        action: "external_write",
      }),
    ).resolves.toBe("navigated:https://example.test");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("TURBO MODE"),
    );
    warn.mockRestore();
    await worker.close();
  });
});
