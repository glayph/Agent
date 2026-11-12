import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import WebSocket from "ws";
import { BrowserTool } from "./runtime.js";

describe("BrowserTool WebExtensions bridge reconciliation", () => {
  let browser: BrowserTool | undefined;
  let dataDir = "";

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = "";
  });

  async function connect(browserId = "test-chrome", browserName = "Chrome", origin = "chrome-extension://miki-test") {
    dataDir ||= fs.mkdtempSync(path.join(os.tmpdir(), "miki-browser-bridge-"));
    browser ||= new BrowserTool(false, dataDir, undefined, { bridgePort: 0, requestTimeoutMs: 2_000 });
    const info = await browser.getBridgeInfo();
    const ws = new WebSocket(`${String(info.wsUrl)}?token=${String(info.token)}`, { headers: { Origin: origin } });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("bridge ready timeout")), 2_000);
      ws.once("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string };
        clearTimeout(timeout);
        if (message.type === "browser.ready") resolve();
        else reject(new Error(`Unexpected bridge message ${message.type}`));
      });
      ws.send(JSON.stringify({ type: "browser.hello", browserId, browserName, version: "test", userAgent: `${browserName} test` }));
    });
    return ws;
  }

  it("authenticates a paired extension and reconciles active browser state", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "browser.state", activeTab: { id: 7, url: "https://example.com/" }, tabs: [{ id: 7, windowId: 1, active: true, title: "Example", url: "https://example.com/", status: "complete" }] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(browser!.listBrowsers()).toMatchObject([{ id: "test-chrome", name: "Chrome", tabCount: 1, activeUrl: "https://example.com/" }]);
    const snapshot = await browser!.reconcileAfterCrash();
    expect(snapshot).toMatchObject({ browserAvailable: true, connectedBrowserCount: 1, activeBrowser: "Chrome", activeUrl: "https://example.com/", tabCount: 1, restoredFromCheckpoint: true });
    ws.close();
  });

  it("uses the requested tab ID rather than overwriting it with the currently active tab", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "browser.state", activeTab: { id: 7, url: "https://example.com/" }, tabs: [{ id: 7, active: true, title: "Example", url: "https://example.com/" }] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; id: string; method: string; params: Record<string, unknown> };
      if (message.type === "rpc.request" && message.method === "tabs.activate") {
        expect(message.params.tabId).toBe(22);
        ws.send(JSON.stringify({ type: "rpc.result", id: message.id, ok: true, result: { tabId: 22, url: "https://example.org/", title: "Other" } }));
      }
    });
    await expect(browser!.selectTab(22)).resolves.toContain("Selected browser tab 22");
    ws.close();
  });

  it("waits for the requested browser instead of accepting a different connected browser", async () => {
    const chrome = await connect();
    const waiting = browser!.waitForBrowserConnection(2_000, undefined, "Firefox");
    const firefox = await connect("test-firefox", "Firefox", "moz-extension://miki-test");
    await expect(waiting).resolves.toMatchObject({ id: "test-firefox", name: "Firefox" });
    expect(browser!.listBrowsers().map((item) => item.name)).toEqual(expect.arrayContaining(["Chrome", "Firefox"]));
    chrome.close();
    firefox.close();
  });

  it("rejects non-bridge WebSocket paths", async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-browser-bridge-path-"));
    browser = new BrowserTool(false, dataDir, undefined, { bridgePort: 0 });
    const info = await browser.getBridgeInfo();
    const wrongUrl = String(info.wsUrl).replace("/miki-browser", "/wrong-path");
    const ws = new WebSocket(`${wrongUrl}?token=${String(info.token)}`, { headers: { Origin: "chrome-extension://miki-test" } });
    const close = await new Promise<number>((resolve, reject) => {
      ws.once("close", (code) => resolve(code));
      ws.once("error", reject);
      setTimeout(() => reject(new Error("bridge path rejection timeout")), 2_000);
    });
    expect(close).toBe(1008);
  });

  it("writes an owner-only pairing token and packages browser-extension targets", async () => {
    const ws = await connect();
    const tokenFile = path.join(dataDir, "browser-bridge-token");
    expect(fs.existsSync(tokenFile)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    const info = await browser!.getBridgeInfo();
    expect(info.supportedFamilies).toContain("Firefox");
    expect(info.extensionDirectory).toContain("extension");
    ws.close();
  });
});
