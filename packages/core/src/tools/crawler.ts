import TurndownService from "turndown";
import { BrowserTool, normalizeBrowserUrl } from "./browser.js";
import type { Page } from "playwright";
import { getErrorMessage } from "../errors.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

function htmlToMarkdown(html: string): string {
  let body = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  body = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  const md = turndown.turndown(body);
  return md.replace(/\n{4,}/g, "\n\n").trim();
}

function requirePage(page: Page | null): Page {
  if (!page) throw new Error("Browser page is not available");
  return page;
}

export class CrawlerAgent {
  public browser: BrowserTool;

  constructor(browser: BrowserTool) {
    this.browser = browser;
  }

  async scrapePage(
    url: string,
    retries: number = 2,
    asMarkdown: boolean = true,
  ): Promise<string> {
    await this.browser.navigate(url, retries);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const urlActual = await this.browser.getUrl();
    const page = requirePage(this.browser.getPage());
    const title: string = await page.title();

    if (asMarkdown) {
      const html: string = await this.browser.getHtml();
      let markdown = htmlToMarkdown(html);
      markdown = markdown.slice(0, 15000);
      return `# ${title}\n\n**URL:** ${urlActual}\n\n---\n\n${markdown.trim()}`;
    } else {
      const body: string = await page.evaluate(
        "document.body?.innerText?.slice(0, 10000) || ''",
      );
      return `URL: ${urlActual}\nTitle: ${title}\n\n${body.trim()}`;
    }
  }

  async scrapeSelectors(
    url: string,
    selectors: string[],
    retries: number = 2,
  ): Promise<string> {
    await this.browser.navigate(url, retries);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const results: string[] = [];
    const page = requirePage(this.browser.getPage());

    for (const sel of selectors) {
      try {
        const pwSel = this.browser.toPlaywrightSelector(sel);
        const elements = await page.$$(pwSel);
        if (!elements || elements.length === 0) {
          results.push(`Selector '${sel}': no matches`);
          continue;
        }
        const texts: string[] = [];
        for (let i = 0; i < Math.min(elements.length, 20); i++) {
          const txt = await elements[i].innerText();
          const htmlContent = await elements[i].innerHTML();
          let md = htmlToMarkdown(htmlContent);
          texts.push(md.trim() || txt.trim());
        }
        results.push(
          `--- ${sel} (${elements.length} matches) ---\n${texts.join("\n\n")}`,
        );
      } catch (e: unknown) {
        results.push(`Selector '${sel}': error - ${getErrorMessage(e)}`);
      }
    }
    return results.join("\n\n");
  }

  async scrapePaginated(
    url: string,
    nextSelector: string,
    maxPages: number = 5,
  ): Promise<string> {
    const allContent: string[] = [];
    let currentUrl = url;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const content = await this.scrapePage(currentUrl, 1, true);
      allContent.push(`=== PAGE ${pageNum} ===\n${content}`);

      if (pageNum < maxPages) {
        try {
          const page = requirePage(this.browser.getPage());
          const pwSel = this.browser.toPlaywrightSelector(nextSelector);
          const el = await page.$(pwSel);
          if (!el) {
            allContent.push("[No more pages - next button not found]");
            break;
          }
          const isDisabled = await el.getAttribute("disabled");
          const classes = (await el.getAttribute("class")) || "";
          if (isDisabled !== null || classes.includes("disabled")) {
            allContent.push("[No more pages - next button disabled]");
            break;
          }
          await el.scrollIntoViewIfNeeded();
          await new Promise((resolve) => setTimeout(resolve, 300));
          await el.click();
          await new Promise((resolve) => setTimeout(resolve, 1500));
          currentUrl = await this.browser.getUrl();
        } catch (e: unknown) {
          allContent.push(
            `[Pagination stopped at page ${pageNum}: ${getErrorMessage(e)}]`,
          );
          break;
        }
      }
    }

    return allContent.join("\n\n");
  }

  async scrapeInfiniteScroll(
    url: string,
    maxScrolls: number = 10,
    scrollPause: number = 1.5,
  ): Promise<string> {
    await this.browser.navigate(url, 2);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const page = requirePage(this.browser.getPage());

    let prevHeight: number = await page.evaluate("document.body.scrollHeight");
    let scrollNum = 0;

    for (scrollNum = 1; scrollNum <= maxScrolls; scrollNum++) {
      await page.evaluate(
        "window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })",
      );
      await new Promise((resolve) => setTimeout(resolve, scrollPause * 1000));
      const newHeight: number = await page.evaluate(
        "document.body.scrollHeight",
      );
      if (newHeight === prevHeight) break;
      prevHeight = newHeight;
    }

    const html: string = await this.browser.getHtml();
    let markdown = htmlToMarkdown(html);
    markdown = markdown.slice(0, 20000);
    const title: string = await page.title();
    const urlActual: string = await this.browser.getUrl();

    return `# ${title} (infinite scroll, ${scrollNum} scrolls)\n**URL:** ${urlActual}\n---\n\n${markdown.trim()}`;
  }

  async scrapeJson(url: string, retries: number = 2): Promise<string> {
    await this.browser.ensureLaunched();
    const page = requirePage(this.browser.getPage());

    try {
      url = normalizeBrowserUrl(url);
    } catch (e: unknown) {
      return `Error scraping JSON from ${url}: ${getErrorMessage(e)}`;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        if (response && response.status() >= 400) {
          throw new Error(
            `HTTP ${response.status()}: ${response.statusText()}`,
          );
        }
        const bodyText: string = await page.evaluate(
          "document.body?.innerText || document.documentElement?.textContent || ''",
        );

        try {
          const parsed = JSON.parse(bodyText);
          return JSON.stringify(parsed, null, 2).slice(0, 15000);
        } catch {
          return `Response (not JSON):\n${bodyText.slice(0, 5000)}`;
        }
      } catch (e: unknown) {
        if (attempt < retries) {
          await this.browser.rotateIdentity();
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          return `Error scraping JSON from ${url}: ${getErrorMessage(e)}`;
        }
      }
    }

    return `Error scraping JSON from ${url}`;
  }

  async extractTable(selector: string = "table"): Promise<string> {
    const page = requirePage(this.browser.getPage());

    const tableData = (await page.evaluate(
      `(sel) => {
        const table = document.querySelector(sel);
        if (!table) return null;
        const rows = table.querySelectorAll("tr");
        return Array.from(rows).map(function(row) {
          const cells = row.querySelectorAll("th, td");
          return Array.from(cells).map(function(c) { return c.innerText.trim(); }).join(" | ");
        });
      }`,
      selector,
    )) as string[] | null;

    if (!tableData || tableData.length === 0) {
      return `No table found matching '${selector}'.`;
    }

    const header = tableData[0];
    const colCount = tableData[0].split(" | ").length;
    const separator = "| " + Array(colCount).fill("---").join(" | ");
    const bodyLines = tableData.slice(1);
    const lines = [header, separator, ...bodyLines];

    return lines.join("\n");
  }
}
