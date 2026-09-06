import { CrawlerAgent } from "./crawler.js";

describe("CrawlerAgent", () => {
  it("scrapes JSON through page navigation instead of page-context fetch", async () => {
    const page = {
      goto: jest.fn(async () => ({
        status: () => 200,
        statusText: () => "OK",
      })),
      evaluate: jest.fn(async () => '{"ok":true,"items":[1,2]}'),
    };
    const browser = {
      ensureLaunched: jest.fn(async () => undefined),
      getPage: jest.fn(() => page),
      rotateIdentity: jest.fn(async () => undefined),
    };
    const crawler = new CrawlerAgent(browser as never);

    const result = await crawler.scrapeJson("example.com/data.json", 0);

    expect(page.goto).toHaveBeenCalledWith("https://example.com/data.json", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    expect(JSON.parse(result)).toEqual({ ok: true, items: [1, 2] });
  });

  it("rejects unsafe JSON scrape URLs before navigation", async () => {
    const page = {
      goto: jest.fn(),
      evaluate: jest.fn(),
    };
    const browser = {
      ensureLaunched: jest.fn(async () => undefined),
      getPage: jest.fn(() => page),
      rotateIdentity: jest.fn(async () => undefined),
    };
    const crawler = new CrawlerAgent(browser as never);

    const result = await crawler.scrapeJson("file:///C:/secret.json", 0);

    expect(page.goto).not.toHaveBeenCalled();
    expect(result).toContain("Unsupported browser URL protocol");
  });
});
