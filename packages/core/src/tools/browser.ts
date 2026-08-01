import * as path from "path";
import * as fs from "fs";
import crypto from "crypto";
import type { BrowserContext, Locator, Page, Route } from "playwright";
import { ProfileManager } from "./profile-manager.js";
import { getErrorMessage } from "../errors.js";

export interface BrowserConfig {
  maxRetries?: number;
  clearStateEveryN?: number;
  chromePath?: string | null;
}

export interface BrowserSemanticTarget {
  selector?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  exact?: boolean;
}

export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("URL is required");
  }
  if (/^(?:javascript|data|file|vbscript):/i.test(trimmed)) {
    throw new Error("Unsupported browser URL protocol");
  }
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Invalid browser URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Browser URL must use http:// or https://");
  }
  return parsed.toString();
}

const USER_AGENTS: string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 OPR/134.0.0.0",
];

const VIEWPORTS: { width: number; height: number }[] = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
];

const NAVIGATION_TIMEOUT = 60000; // Reduced from 90s
const NETWORK_IDLE_TIMEOUT = 15000; // Reduced from 30s
const DELAY_SHORT: [number, number] = [100, 500]; // Reduced for speed
const DELAY_MEDIUM: [number, number] = [200, 800]; // Reduced for speed
const DELAY_LONG: [number, number] = [500, 1200]; // Reduced for speed

interface VirtualCursorElement {
  id: string;
  style: Record<string, string>;
  appendChild(child: VirtualCursorElement): void;
}

interface VirtualCursorDocument {
  getElementById(id: string): VirtualCursorElement | null;
  createElement(tagName: string): VirtualCursorElement;
  body: { appendChild(child: VirtualCursorElement): void };
}

interface VirtualCursorGlobal {
  document: VirtualCursorDocument;
  scrollX: number;
  scrollY: number;
}

export class BrowserTool {
  private browser: BrowserContext | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private headless: boolean;
  private screenshotDir: string;
  private userAgent: string;
  private viewport: { width: number; height: number };
  private launchLock: Promise<void> | null = null;
  private maxNavigationsBeforeClear: number = 5;
  private navCount: number = 0;
  private profileManager: ProfileManager | null = null;
  private profileDir: string = "";
  private _maxRetries: number = 3;
  private _chromePath: string | null = null;

  constructor(
    headless: boolean = false,
    dataDir: string = "data",
    profileManager?: ProfileManager,
    config?: BrowserConfig,
  ) {
    this.headless = headless;
    this.screenshotDir = path.resolve(dataDir, "screenshots");
    this.userAgent =
      USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    this.viewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    if (profileManager) this.profileManager = profileManager;
    if (config) {
      if (config.maxRetries != null) this._maxRetries = config.maxRetries;
      if (config.clearStateEveryN != null)
        this.maxNavigationsBeforeClear = config.clearStateEveryN;
      if (config.chromePath) this._chromePath = config.chromePath;
    }
  }

  private get contextConfig(): Record<string, unknown> {
    return {
      viewport: this.viewport,
      userAgent: this.userAgent,
      locale: "en-US",
      timezoneId: "America/New_York",
      permissions: ["geolocation"],
      javaScriptEnabled: true,
      bypassCSP: true,
      ignoreHTTPSErrors: true,
    };
  }

  private randomDelay(minMs?: number, maxMs?: number): Promise<void> {
    const lo = minMs ?? DELAY_SHORT[0];
    const hi = maxMs ?? DELAY_SHORT[1];
    const ms = Math.floor(Math.random() * (hi - lo + 1)) + lo;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async randomScroll(): Promise<void> {
    const deltaY = Math.floor(Math.random() * 601) + 200;
    await this.activePage.evaluate(
      `window.scrollBy({ top: ${deltaY}, behavior: 'smooth' })`,
    );
  }

  private get activePage(): Page {
    if (!this.page) {
      throw new Error("Browser page is not available");
    }
    return this.page;
  }

  private async _setupRequestInterception(page: Page): Promise<void> {
    const adDomains = [
      "doubleclick.net",
      "googleadservices.com",
      "googlesyndication.com",
      "google-analytics.com",
      "googletagmanager.com",
      "facebook.net",
      "fbcdn.net",
      "amazon-adsystem.com",
      "ads.linkedin.com",
      "ads-twitter.com",
      "adservice.google.com",
      "pagead2.googlesyndication.com",
      "analytics.tiktok.com",
      "bat.bing.com",
      "criteo.net",
      "criteo.com",
      "scorecardresearch.com",
      "quantserve.com",
      "zedo.com",
      "adnxs.com",
      "rubiconproject.com",
      "moatads.com",
      "outbrain.com",
      "taboola.com",
    ];
    // Also block media/images if requested for ultra-fast mode (optional)
    await page.route("**/*", async (route: Route) => {
      const url = route.request().url().toLowerCase();
      const resourceType = route.request().resourceType();

      const isAd = adDomains.some((d) => url.includes(d));
      if (
        isAd ||
        resourceType === "image" ||
        resourceType === "media" ||
        resourceType === "font"
      ) {
        await route.abort();
        return;
      }
      await route.continue();
    });
  }

  private async _injectVirtualCursor(): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.evaluate(() => {
        const doc = (globalThis as unknown as VirtualCursorGlobal).document;
        if (doc.getElementById("Hiro-virtual-cursor")) return;
        const cursor = doc.createElement("div");
        cursor.id = "Hiro-virtual-cursor";
        Object.assign(cursor.style, {
          position: "absolute",
          width: "24px",
          height: "24px",
          backgroundColor: "rgba(255, 69, 0, 0.6)",
          border: "2px solid #ffffff",
          borderRadius: "50%",
          pointerEvents: "none",
          zIndex: "2147483647",
          transform: "translate(-50%, -50%)",
          left: "0px",
          top: "0px",
          boxShadow: "0 0 8px rgba(0, 0, 0, 0.6)",
          transition:
            "transform 0.08s ease-out, background-color 0.08s ease-out",
        });

        const core = doc.createElement("div");
        Object.assign(core.style, {
          position: "absolute",
          left: "50%",
          top: "50%",
          width: "8px",
          height: "8px",
          backgroundColor: "#ff0000",
          borderRadius: "50%",
          transform: "translate(-50%, -50%)",
        });

        cursor.appendChild(core);
        doc.body.appendChild(cursor);
      });
    } catch (e) {
      console.warn("[BrowserTool] Failed to inject virtual cursor:", e);
    }
  }

  private async _teleportVirtualCursor(
    viewportX: number,
    viewportY: number,
  ): Promise<void> {
    if (!this.page) return;
    await this._injectVirtualCursor();
    try {
      await this.page.evaluate(
        (args: { x: number; y: number }) => {
          const win = globalThis as unknown as VirtualCursorGlobal;
          const doc = win.document;
          const cursor = doc.getElementById("Hiro-virtual-cursor");
          if (cursor) {
            const pageX = args.x + win.scrollX;
            const pageY = args.y + win.scrollY;
            cursor.style.left = `${pageX}px`;
            cursor.style.top = `${pageY}px`;
          }
        },
        { x: viewportX, y: viewportY },
      );
    } catch {
      // Best-effort teleportation
    }
  }

  private async _animateClickFlash(): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.evaluate(() => {
        const doc = (globalThis as unknown as VirtualCursorGlobal).document;
        const cursor = doc.getElementById("Hiro-virtual-cursor");
        if (cursor) {
          cursor.style.transform = "translate(-50%, -50%) scale(0.6)";
          cursor.style.backgroundColor = "rgba(255, 0, 0, 0.9)";
          setTimeout(() => {
            cursor.style.transform = "translate(-50%, -50%) scale(1.0)";
            cursor.style.backgroundColor = "rgba(255, 69, 0, 0.6)";
          }, 80);
        }
      });
      await this.randomDelay(80, 100);
    } catch {
      // Best-effort animation
    }
  }

  public async ensureLaunched(): Promise<void> {
    if (this.launchLock) {
      await this.launchLock;
      return;
    }
    this.launchLock = this._ensureLaunchedImpl();
    try {
      await this.launchLock;
    } finally {
      this.launchLock = null;
    }
  }

  private async _ensureLaunchedImpl(): Promise<void> {
    if (this.page !== null) {
      try {
        const closed = this.page.isClosed();
        if (!closed) {
          // Check if page is responsive
          await Promise.race([
            this.activePage.title(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Page unresponsive")), 5000),
            ),
          ]);
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[BrowserTool] Existing page check failed: ${msg}. Re-launching...`,
        );
        await this.close();
      }
    }
    await this.launchBrowser();
  }

  private async launchBrowser(): Promise<void> {
    this.profileDir = path.join(
      this.screenshotDir,
      "..",
      "chrome_agent_profile",
    );

    // For launchPersistentContext, the browser and context are essentially the same or linked
    this.context = await this._launchPlaywright();
    this.browser = this.context; // Store it as browser for compatibility with close()

    const pages = this.context.pages();
    if (pages.length > 0) {
      this.page = pages[0];
    } else {
      this.page = await this.context.newPage();
    }
    await this._setupRequestInterception(this.page);

    if (this.profileManager) {
      this.profileManager.register("default", this.profileDir);
    }
  }

  public async navigate(url: string, retries?: number): Promise<string> {
    await this.ensureLaunched();

    url = normalizeBrowserUrl(url);

    const maxAttempts = retries ?? this._maxRetries;
    let lastError: string | null = null;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      try {
        const page = this.activePage;
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT,
        });

        if (response && response.status() >= 400) {
          throw new Error(
            `HTTP ${response.status()}: ${response.statusText()}`,
          );
        }

        try {
          await page.waitForLoadState("networkidle", {
            timeout: NETWORK_IDLE_TIMEOUT,
          });
        } catch (err) {
          console.warn(`[BrowserTool] networkidle timeout:`, err);
        }

        // Human-like post-navigation behavior
        await this.randomDelay(DELAY_MEDIUM[0], DELAY_MEDIUM[1]);
        await this.randomScroll();
        await this.randomDelay(500, 1200);

        const title: string = await this.activePage.title();
        const currentUrl: string = this.activePage.url();

        this.navCount++;
        if (this.navCount % this.maxNavigationsBeforeClear === 0) {
          await this.rotateIdentity();
          this.navCount = 0;
        }

        return `Successfully navigated to: ${currentUrl}\nTitle: ${title}`;
      } catch (e: unknown) {
        lastError = getErrorMessage(e);
        console.warn(
          `[BrowserTool] Navigation attempt ${attempt + 1} failed: ${lastError}`,
        );

        if (attempt < maxAttempts) {
          // Close stale page before retry to prevent memory leaks
          try {
            if (this.page && !this.page.isClosed()) {
              await this.page.close();
            }
          } catch {
            // Best-effort close
          }
          this.page = null;

          await this.rotateIdentity();
          const backoff = Math.pow(2, attempt) * 2000;
          await this.randomDelay(backoff, backoff + 1000);
        } else {
          // Final attempt failed, try to return whatever we have
          try {
            const currentUrl = this.activePage.url();
            const title = await this.activePage.title();
            return `Navigation partially failed after ${maxAttempts + 1} attempts. Current URL: ${currentUrl}, Title: ${title}. Last Error: ${lastError}`;
          } catch {
            return `Navigation failed after ${maxAttempts + 1} attempts. Last Error: ${lastError}`;
          }
        }
      }
    }
    return `Error: Navigation to ${url} failed.`;
  }

  public async click(selector: string): Promise<string> {
    await this.ensureLaunched();
    try {
      const pwSelector = this.toPlaywrightSelector(selector);
      const page = this.activePage;
      await page.waitForSelector(pwSelector, { timeout: 10000 });
      const el = await page.$(pwSelector);
      if (!el)
        return "Error: Could not find element matching '" + selector + "'.";
      await el.scrollIntoViewIfNeeded();

      // Calculate coordinates to teleport virtual cursor
      const box = await el.boundingBox();
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await this._teleportVirtualCursor(x, y);
        await page.mouse.move(x, y);
        await this._animateClickFlash();
        await page.mouse.click(x, y);
      } else {
        // Fallback for hidden or non-layout elements
        await this.randomDelay();
        await el.click();
      }

      await this.randomDelay(DELAY_MEDIUM[0], DELAY_MEDIUM[1]);
      return "Clicked element: " + selector;
    } catch (e: unknown) {
      return "Error clicking '" + selector + "': " + getErrorMessage(e);
    }
  }

  public async type(
    selector: string,
    text: string,
    enter: boolean = false,
  ): Promise<string> {
    await this.ensureLaunched();
    try {
      const pwSelector = this.toPlaywrightSelector(selector);
      const page = this.activePage;
      await page.waitForSelector(pwSelector, { timeout: 10000 });
      const el = await page.$(pwSelector);
      if (!el)
        return "Error: Could not find element matching '" + selector + "'.";
      await el.scrollIntoViewIfNeeded();

      // Teleport visual cursor to focus the input element
      const box = await el.boundingBox();
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await this._teleportVirtualCursor(x, y);
        await page.mouse.move(x, y);
        await this._animateClickFlash();
        await page.mouse.click(x, y);
      } else {
        await this.randomDelay();
        await el.click();
      }

      await el.fill("");
      for (const ch of text) {
        const delay = Math.floor(Math.random() * 41) + 20; // Slightly faster human-like typing
        await el.type(ch, { delay });
      }
      if (enter) {
        await this.randomDelay(DELAY_SHORT[0], DELAY_SHORT[1]);
        await page.keyboard.press("Enter");
        await this.randomDelay(DELAY_LONG[0], DELAY_LONG[1]);
      }
      return (
        "Typed '" +
        text +
        "' into " +
        selector +
        (enter ? " and pressed Enter" : "")
      );
    } catch (e: unknown) {
      return "Error typing into '" + selector + "': " + getErrorMessage(e);
    }
  }

  private resolveSemanticLocator(target: BrowserSemanticTarget): Locator {
    const page = this.activePage;
    if (target.selector) {
      return page.locator(this.toPlaywrightSelector(target.selector)).first();
    }
    const exact = target.exact ?? false;
    if (target.role) {
      const getByRole = page.getByRole as unknown as (
        role: string,
        options?: { name?: string; exact?: boolean },
      ) => Locator;
      return getByRole(target.role, {
        name: target.name || target.text,
        exact,
      }).first();
    }
    if (target.label) {
      return page.getByLabel(target.label, { exact }).first();
    }
    if (target.placeholder) {
      return page.getByPlaceholder(target.placeholder, { exact }).first();
    }
    if (target.text || target.name) {
      return page
        .getByText(target.text || target.name || "", { exact })
        .first();
    }
    throw new Error(
      "A semantic browser target is required: selector, role/name, label, placeholder, or text.",
    );
  }

  public async invoke(target: BrowserSemanticTarget): Promise<string> {
    await this.ensureLaunched();
    try {
      const locator = this.resolveSemanticLocator(target);
      await locator.waitFor({ state: "attached", timeout: 10000 });
      await locator.scrollIntoViewIfNeeded();
      await locator.evaluate((node: unknown) => {
        const element = node as {
          focus?: () => void;
          click?: () => void;
          dispatchEvent?: (event: unknown) => boolean;
          ownerDocument?: {
            defaultView?: {
              MouseEvent?: new (
                type: string,
                init?: Record<string, unknown>,
              ) => unknown;
            };
          };
        };
        element.focus?.();
        if (typeof element.click === "function") {
          element.click();
          return;
        }
        const MouseEventCtor = element.ownerDocument?.defaultView?.MouseEvent;
        if (!MouseEventCtor || !element.dispatchEvent) return;
        element.dispatchEvent(
          new MouseEventCtor("click", {
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await this.randomDelay(DELAY_SHORT[0], DELAY_SHORT[1]);
      return "Invoked browser element without physical mouse movement.";
    } catch (e: unknown) {
      return "Error invoking browser element: " + getErrorMessage(e);
    }
  }

  public async fill(
    target: BrowserSemanticTarget,
    text: string,
    enter: boolean = false,
  ): Promise<string> {
    await this.ensureLaunched();
    try {
      const locator = this.resolveSemanticLocator(target);
      await locator.waitFor({ state: "attached", timeout: 10000 });
      await locator.fill(text);
      if (enter) {
        await locator.press("Enter");
      }
      return "Filled browser field without physical mouse movement.";
    } catch (e: unknown) {
      return "Error filling browser field: " + getErrorMessage(e);
    }
  }

  public async press(
    target: BrowserSemanticTarget | undefined,
    key: string,
  ): Promise<string> {
    await this.ensureLaunched();
    try {
      if (target) {
        const locator = this.resolveSemanticLocator(target);
        await locator.waitFor({ state: "attached", timeout: 10000 });
        await locator.focus();
        await locator.press(key);
      } else {
        await this.activePage.keyboard.press(key);
      }
      return "Pressed browser key without physical mouse movement.";
    } catch (e: unknown) {
      return "Error pressing browser key: " + getErrorMessage(e);
    }
  }

  public async extract(selector?: string): Promise<string> {
    await this.ensureLaunched();
    try {
      if (selector) {
        const page = this.activePage;
        const elements = await page.$$(selector);
        if (!elements || elements.length === 0) {
          return "No elements found matching '" + selector + "'.";
        }
        const results: string[] = [];
        for (let i = 0; i < Math.min(elements.length, 20); i++) {
          const text = await elements[i].innerText();
          results.push("[" + i + "] " + text.trim());
        }
        return results.length ? results.join("\n") : "(empty elements)";
      } else {
        const page = this.activePage;
        const title: string = await page.title();
        const currentUrl: string = page.url();
        const body: string = await page.evaluate(
          "document.body?.innerText?.slice(0, 5000) || ''",
        );
        return (
          "URL: " + currentUrl + "\nTitle: " + title + "\n\n" + body.trim()
        );
      }
    } catch (e: unknown) {
      return "Error extracting content: " + getErrorMessage(e);
    }
  }

  public async screenshot(): Promise<string> {
    await this.ensureLaunched();
    try {
      const filename =
        "screenshot_" +
        crypto.randomUUID().replace(/-/g, "").slice(0, 8) +
        ".png";
      const filepath = path.join(this.screenshotDir, filename);
      await this.activePage.screenshot({ path: filepath, fullPage: false });
      return "Screenshot saved to: " + filepath;
    } catch (e: unknown) {
      return "Error taking screenshot: " + getErrorMessage(e);
    }
  }

  private async _launchPlaywright(): Promise<BrowserContext> {
    const { chromium } = await import("playwright");
    // Playwright recommends launchPersistentContext for using a specific user data directory
    return await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      viewport: this.viewport,
      userAgent: this.userAgent,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-infobars",
        "--disable-features=IsolateOrigins,site-per-process",
        "--autoplay-policy=no-user-gesture-required",
        "--mute-audio",
      ],
    });
  }

  public async close(): Promise<string> {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (err) {
        console.warn(`[BrowserTool] close error:`, err);
      }
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    if (this.profileManager) this.profileManager.releaseActive();
    return "Browser closed.";
  }

  public getPage(): Page | null {
    return this.page;
  }

  public async getHtml(): Promise<string> {
    await this.ensureLaunched();
    return await this.activePage.content();
  }

  public async getUrl(): Promise<string> {
    await this.ensureLaunched();
    return this.activePage.url();
  }

  public async scrollDown(pixels?: number): Promise<string> {
    await this.ensureLaunched();
    const amount = pixels ?? Math.floor(Math.random() * 501) + 400;
    await this.activePage.evaluate(
      `window.scrollBy({ top: ${amount}, behavior: 'smooth' })`,
    );
    await this.randomDelay(DELAY_SHORT[0], DELAY_SHORT[1]);
    return "Scrolled down " + amount + "px.";
  }

  public async scrollToBottom(): Promise<string> {
    await this.ensureLaunched();
    await this.activePage.evaluate(
      "window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })",
    );
    await this.randomDelay(DELAY_MEDIUM[0], DELAY_MEDIUM[1]);
    return "Scrolled to bottom of page.";
  }

  public async rotateIdentity(): Promise<void> {
    this.userAgent =
      USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    this.viewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
    if (this.context) {
      try {
        await this.context.clearCookies();
      } catch (err) {
        console.warn(`[BrowserTool] clearCookies error:`, err);
      }
      try {
        await this.context.close();
      } catch (err) {
        console.warn(`[BrowserTool] context close error:`, err);
      }
      this.context = null;
      this.page = null;
    }
    this.browser = null;
    await this.launchBrowser();
  }

  public toPlaywrightSelector(selector: string): string {
    if (selector.startsWith("//") || selector.startsWith("(//"))
      return "xpath=" + selector;
    if (selector.startsWith("text=") || selector.startsWith("xpath="))
      return selector;
    return selector;
  }
}
