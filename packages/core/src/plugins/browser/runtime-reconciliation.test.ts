import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, describe, expect, it, jest } from "@jest/globals";

const mocks = { launchPersistentContext: jest.fn() };
jest.unstable_mockModule("playwright", () => ({ chromium: { launchPersistentContext: mocks.launchPersistentContext } }));
const { BrowserTool } = await import("./runtime.js");

function makeBrowserFixture(url = "https://example.com/") {
  let closed = false;
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const page = {
    isClosed: () => closed,
    url: () => url,
    title: async () => "Example",
    mainFrame: () => frame,
    on: (event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return page;
    },
    route: jest.fn(async () => undefined),
    evaluate: jest.fn(async () => ({ title: "Example", readyState: "complete", url })),
    setViewportSize: jest.fn(async () => undefined),
    close: jest.fn(async () => { closed = true; }),
    screenshot: jest.fn(async () => undefined),
  };
  const frame = {};
  const context = {
    pages: () => closed ? [] : [page],
    newPage: jest.fn(async () => page),
    close: jest.fn(async () => { closed = true; }),
    clearCookies: jest.fn(async () => undefined),
  };
  return { page, context, markClosed: () => { closed = true; }, listeners };
}

describe("BrowserTool persistent session reconciliation", () => {
  let dataDir = "";
  let browser: BrowserTool | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-browser-reconcile-"));
    mocks.launchPersistentContext.mockReset();
  });

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("reconciles a live persistent context and records the current page without clearing cookies", async () => {
    const fixture = makeBrowserFixture();
    mocks.launchPersistentContext.mockResolvedValue(fixture.context);
    browser = new BrowserTool(true, dataDir);
    const snapshot = await browser.reconcileAfterCrash();
    expect(snapshot).toMatchObject({ browserAvailable: true, activeUrl: "https://example.com/", title: "Example", readyState: "complete", pageCount: 1 });
    expect(fs.existsSync(path.join(dataDir, "browser-session-state.json"))).toBe(true);
    await browser.rotatePresentation();
    expect(fixture.context.clearCookies).not.toHaveBeenCalled();
    expect(fixture.context.close).not.toHaveBeenCalled();
    expect(fixture.page.setViewportSize).toHaveBeenCalledTimes(1);
  });

  it("reuses the existing context when the active page reference is lost", async () => {
    const fixture = makeBrowserFixture();
    mocks.launchPersistentContext.mockResolvedValue(fixture.context);
    browser = new BrowserTool(true, dataDir);
    await browser.ensureLaunched();
    (browser as unknown as { page: null }).page = null;
    await browser.ensureLaunched();
    expect(mocks.launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(browser.getPage()).toBe(fixture.page as any);
  });
});
