import * as path from "path";
import * as fs from "fs";
import { createServer, type Server } from "node:http";
import crypto from "crypto";
import { validateNetworkUrl } from "../../autonomy/network-security.js";
import type { BrowserContext, Locator, Page, Route } from "playwright";
import { ProfileManager } from "./profile-manager.js";
import { getErrorMessage } from "../../errors.js";

export interface BrowserConfig {
  maxRetries?: number;
  clearStateEveryN?: number;
  chromePath?: string | null;
  allowMedia?: boolean;
  allowPrivateNetworks?: boolean;
}

export interface BrowserReconciliationSnapshot {
  browserAvailable: boolean;
  pageCount: number;
  activeUrl: string;
  title: string;
  readyState: string;
  reconciledAt: string;
  restoredFromCheckpoint: boolean;
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

export function rewriteWorkspacePreviewUrl(
  input: string,
  ownedPort: number,
): string {
  const parsed = new URL(normalizeBrowserUrl(input));
  if (
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
    parsed.port === "8765"
  ) {
    parsed.port = String(ownedPort);
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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("Browser operation was cancelled.");
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error("Browser operation was cancelled."));
    };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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

interface BrowserMediaElement {
  tagName: string;
  currentSrc: string;
  src: string;
  controls: boolean;
  playsInline: boolean;
  muted: boolean;
  style?: { maxWidth: string };
  readyState: number;
  paused: boolean;
  currentTime: number;
  duration: number;
  load?: () => void;
  play?: () => Promise<void>;
  addEventListener?: (
    type: string,
    listener: () => void,
    options?: { once?: boolean },
  ) => void;
}

interface BrowserMediaDocument {
  querySelector(selector: string): BrowserMediaElement | null;
  createElement(tagName: string): BrowserMediaElement;
  body: { appendChild(child: BrowserMediaElement): void };
}

export class BrowserTool {
  private browser: BrowserContext | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private headless: boolean;
  private screenshotDir: string;
  private workspaceDir: string | null = null;
  private userAgent: string;
  private viewport: { width: number; height: number };
  private launchLock: Promise<void> | null = null;
  private maxNavigationsBeforeClear: number = 5;
  private navCount: number = 0;
  private profileManager: ProfileManager | null = null;
  private profileDir: string = "";
  private readonly sessionStatePath: string;
  private lastKnownPageUrl = "";
  private readonly observedPages = new WeakSet<Page>();
  // Browser navigation is a recoverable tool operation: retry transient browser/network
  // failures until the caller cancels or the failure is classified as permanent.
  private _maxRetries: number = Number.POSITIVE_INFINITY;
  private _chromePath: string | null = null;
  private _allowMedia = true;
  // Safe baseline: loopback, private and cloud-metadata addresses are blocked unless restrictions are bypassed.
  private _allowPrivateNetworks = false;
  private _allowedDomains: string[] = [];
  private workspacePreviewServer: Server | null = null;
  private workspacePreviewRoot: string | null = null;
  private workspacePreviewPort: number | null = null;
  private workspacePreviewStart: Promise<void> | null = null;

  constructor(
    headless: boolean = false,
    dataDir: string = "data",
    profileManager?: ProfileManager,
    config?: BrowserConfig,
  ) {
    this.headless = headless;
    this.screenshotDir = path.resolve(dataDir, "screenshots");
    this.sessionStatePath = path.resolve(dataDir, "browser-session-state.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.sessionStatePath, "utf8")) as { url?: unknown };
      if (typeof saved.url === "string" && /^https?:\/\//i.test(saved.url)) this.lastKnownPageUrl = saved.url;
    } catch { /* A missing or malformed browser checkpoint is treated as an empty session. */ }
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
      if (config.allowMedia != null) this._allowMedia = config.allowMedia;
      if (config.allowPrivateNetworks != null) this._allowPrivateNetworks = config.allowPrivateNetworks;
    }
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

  public currentUrl(): string {
    return this.page?.url() || "";
  }

  public setBypassRestrictions(enabled: boolean): void {
    if (enabled) {
      this._allowedDomains = [];
      this._allowPrivateNetworks = true;
      return;
    }
    // Turning the bypass off restores the safe baseline, including the private-network block.
    this._allowPrivateNetworks = false;
  }

  public setAllowedDomains(domains: string[]): void {
    this._allowedDomains = domains
      .map((domain) => domain.trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
      .filter(Boolean);
  }

  private async assertAutonomousDomain(url: string): Promise<void> {
    if (!this._allowedDomains.length) return;
    await validateNetworkUrl(url, {
      allowedDomains: this._allowedDomains,
      allowPrivateNetworks: this._allowPrivateNetworks,
    });
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
      const rawUrl = route.request().url();
      const url = rawUrl.toLowerCase();
      const resourceType = route.request().resourceType();

      try {
        const parsed = new URL(rawUrl);
        const isOwnedPreview =
          (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
          this.workspacePreviewPort != null &&
          Number(parsed.port || 80) === this.workspacePreviewPort;
        if (!isOwnedPreview) {
          await validateNetworkUrl(rawUrl, { allowPrivateNetworks: this._allowPrivateNetworks });
        }
      } catch {
        await route.abort();
        return;
      }

      const isAd = adDomains.some((d) => url.includes(d));
      if (
        isAd ||
        resourceType === "image" ||
        (resourceType === "media" && !this._allowMedia) ||
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
        if (doc.getElementById("Miki-virtual-cursor")) return;
        const cursor = doc.createElement("div");
        cursor.id = "Miki-virtual-cursor";
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
          const cursor = doc.getElementById("Miki-virtual-cursor");
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
        const cursor = doc.getElementById("Miki-virtual-cursor");
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
    if (this.context !== null) {
      try {
        if (!this.page || this.page.isClosed()) {
          const replacement = this.context.pages().find((candidate) => !candidate.isClosed());
          // Page interception/observation is installed by reconcilePageState;
          // do not mark a replacement as observed before security routes exist.
          this.page = replacement ?? await this.context.newPage();
        }
        await Promise.race([
          this.activePage.title(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Page unresponsive")), 5000)),
        ]);
        await this.reconcilePageState();
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[BrowserTool] Browser state reconciliation failed: ${msg}. Re-launching persistent context...`);
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

    const pages = this.context.pages().filter((candidate) => !candidate.isClosed());
    this.page = pages.find((candidate) => this.lastKnownPageUrl && candidate.url() === this.lastKnownPageUrl)
      ?? pages.find((candidate) => candidate.url() !== "about:blank")
      ?? pages[0]
      ?? await this.context.newPage();
    this.observePage(this.page);
    await this._setupRequestInterception(this.page);
    await this.restoreSavedPageIfBlank();

    if (this.profileManager) {
      this.profileManager.register("default", this.profileDir);
    }
  }

  private observePage(page: Page): void {
    if (this.observedPages.has(page)) return;
    this.observedPages.add(page);
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      this.lastKnownPageUrl = page.url();
      this.persistSessionCheckpoint();
    });
    page.on("close", () => {
      if (this.page === page && this.context) {
        try {
          const replacement = this.context.pages().find((candidate) => !candidate.isClosed());
          // The next ensureLaunched/reconcile pass installs routes before use.
          this.page = replacement ?? null;
        } catch {
          this.page = null;
        }
      }
    });
  }

  private persistSessionCheckpoint(): void {
    const url = this.page?.url() ?? this.lastKnownPageUrl;
    if (!url || !/^https?:\/\//i.test(url)) return;
    try {
      fs.mkdirSync(path.dirname(this.sessionStatePath), { recursive: true });
      const temporary = `${this.sessionStatePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ url, savedAt: new Date().toISOString() }), { mode: 0o600 });
      fs.renameSync(temporary, this.sessionStatePath);
    } catch (error) {
      console.warn(`[BrowserTool] Could not persist page checkpoint: ${getErrorMessage(error)}`);
    }
  }

  private async restoreSavedPageIfBlank(): Promise<void> {
    if (!this.page || !this.lastKnownPageUrl || this.page.url() !== "about:blank") return;
    try {
      const safeUrl = await validateNetworkUrl(this.lastKnownPageUrl, {
        allowedDomains: this._allowedDomains,
        allowPrivateNetworks: this._allowPrivateNetworks,
      });
      await this.page.goto(safeUrl.toString(), { waitUntil: "domcontentloaded", timeout: Math.min(NAVIGATION_TIMEOUT, 20_000) });
    } catch (error) {
      // Do not clear cookies or profile data when a page cannot be restored.
      console.warn(`[BrowserTool] Saved page was not restored: ${getErrorMessage(error)}`);
    }
  }

  private async reconcilePageState(): Promise<BrowserReconciliationSnapshot> {
    if (!this.context) throw new Error("Browser context is unavailable during reconciliation.");
    const pages = this.context.pages().filter((candidate) => !candidate.isClosed());
    const selected = pages.find((candidate) => this.lastKnownPageUrl && candidate.url() === this.lastKnownPageUrl)
      ?? (this.page && !this.page.isClosed() ? this.page : undefined)
      ?? pages.find((candidate) => candidate.url() !== "about:blank")
      ?? pages[0]
      ?? await this.context.newPage();
    const savedUrl = this.lastKnownPageUrl;
    const matchedCheckpoint = Boolean(savedUrl && selected.url() === savedUrl);
    const needsRequestInterception = !this.observedPages.has(selected);
    this.page = selected;
    this.observePage(selected);
    if (needsRequestInterception) await this._setupRequestInterception(selected);
    await this.restoreSavedPageIfBlank();
    const dom = await selected.evaluate(() => {
      // This callback runs in the browser page; the core package compiles with Node-only DOM typings.
      const pageGlobal = globalThis as unknown as {
        document: { title: string; readyState: string };
        location: { href: string };
      };
      return {
        title: pageGlobal.document.title || "",
        readyState: pageGlobal.document.readyState || "unknown",
        url: pageGlobal.location.href,
      };
    });
    this.lastKnownPageUrl = dom.url;
    this.persistSessionCheckpoint();
    return {
      browserAvailable: true,
      pageCount: Math.max(1, pages.length),
      activeUrl: dom.url,
      title: dom.title,
      readyState: dom.readyState,
      reconciledAt: new Date().toISOString(),
      restoredFromCheckpoint: matchedCheckpoint || Boolean(savedUrl && dom.url === savedUrl),
    };
  }

  /** Reconcile Playwright context, live pages, DOM readiness and the last safe URL checkpoint. */
  public async reconcileAfterCrash(): Promise<BrowserReconciliationSnapshot> {
    await this.ensureLaunched();
    return this.reconcilePageState();
  }

  private async _ensureWorkspacePreviewServer(): Promise<void> {
    const configuredRoot = this.workspaceDir;
    if (!configuredRoot) return;
    let root: string;
    try {
      root = fs.realpathSync(configuredRoot);
    } catch {
      return;
    }
    if (this.workspacePreviewServer && this.workspacePreviewRoot === root)
      return;
    if (this.workspacePreviewServer) {
      await new Promise<void>((resolve) =>
        this.workspacePreviewServer?.close(() => resolve()),
      );
      this.workspacePreviewServer = null;
      this.workspacePreviewRoot = null;
      this.workspacePreviewPort = null;
    }
    if (this.workspacePreviewStart) return this.workspacePreviewStart;

    const start = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { Allow: "GET, HEAD" });
          response.end();
          return;
        }

        let pathname: string;
        try {
          pathname = decodeURIComponent(
            new URL(request.url || "/", "http://127.0.0.1").pathname,
          );
        } catch {
          response.writeHead(400);
          response.end("Bad request");
          return;
        }
        const target = path.resolve(root, `.${pathname}`);
        const relative = path.relative(root, target);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          response.writeHead(403);
          response.end("Forbidden");
          return;
        }

        let filePath = target;
        let fd: number | undefined;
        try {
          // lstat every existing component: stat() alone follows symlinks and can
          // expose files outside the workspace through an apparently safe URL.
          let cursor = root;
          for (const segment of relative.split(path.sep).filter(Boolean)) {
            cursor = path.join(cursor, segment);
            if (fs.lstatSync(cursor).isSymbolicLink()) {
              response.writeHead(403);
              response.end("Forbidden");
              return;
            }
          }
          if (fs.statSync(filePath).isDirectory()) {
            filePath = path.join(filePath, "index.html");
            if (fs.lstatSync(filePath).isSymbolicLink()) {
              response.writeHead(403);
              response.end("Forbidden");
              return;
            }
          }

          const canonicalFile = fs.realpathSync(filePath);
          const canonicalRelative = path.relative(root, canonicalFile);
          if (
            canonicalRelative === ".." ||
            canonicalRelative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(canonicalRelative)
          ) {
            response.writeHead(403);
            response.end("Forbidden");
            return;
          }

          // Open the canonical path and use the descriptor for both metadata and
          // streaming. O_NOFOLLOW closes the final-component symlink race where supported.
          const noFollow = fs.constants.O_NOFOLLOW ?? 0;
          fd = fs.openSync(canonicalFile, fs.constants.O_RDONLY | noFollow);
          const stat = fs.fstatSync(fd);
          if (!stat.isFile()) throw new Error("Not a file");
          const ext = path.extname(canonicalFile).toLowerCase();
          const contentType: Record<string, string> = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
          };
          response.writeHead(200, {
            "Content-Type": contentType[ext] || "application/octet-stream",
            "Content-Length": stat.size,
            "Cache-Control": "no-store",
          });
          if (request.method === "HEAD") {
            fs.closeSync(fd);
            fd = undefined;
            response.end();
          } else {
            const stream = fs.createReadStream(canonicalFile, { fd, autoClose: true });
            fd = undefined;
            stream.on("error", () => response.destroy());
            stream.pipe(response);
          }
        } catch {
          if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* already closed */ }
          }
          if (!response.headersSent) {
            response.writeHead(404);
            response.end("Not found");
          } else {
            response.destroy();
          }
        }
      });

      server.once("error", (error: NodeJS.ErrnoException) => {
        reject(error);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(
            new Error("workspace preview server did not expose a TCP port"),
          );
          return;
        }
        this.workspacePreviewServer = server;
        this.workspacePreviewRoot = root;
        this.workspacePreviewPort = address.port;
        resolve();
      });
    });
    this.workspacePreviewStart = start;
    try {
      await start;
    } finally {
      this.workspacePreviewStart = null;
    }
  }

  public async navigate(
    url: string,
    retries?: number,
    signal?: AbortSignal,
    heartbeat?: (detail?: string) => void,
  ): Promise<string> {
    throwIfAborted(signal);
    await this.ensureLaunched();
    throwIfAborted(signal);
    url = normalizeBrowserUrl(url);
    await this.assertAutonomousDomain(url);
    const parsedUrl = new URL(url);
    if (
      (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost") &&
      parsedUrl.port === "8765"
    ) {
      await this._ensureWorkspacePreviewServer();
      if (this.workspacePreviewPort) url = rewriteWorkspacePreviewUrl(url, this.workspacePreviewPort);
    }

    const abortPage = () => {
      const active = this.page;
      this.page = null;
      if (active && !active.isClosed()) void active.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", abortPage, { once: true });
    const heartbeatTimer = heartbeat
      ? setInterval(() => heartbeat("Browser navigation is waiting for page load"), 10_000)
      : undefined;
    const maxAttempts = retries === undefined ? this._maxRetries : Math.max(0, Math.floor(retries));
    let lastError: string | null = null;

    try {
      for (let attempt = 0; attempt <= maxAttempts; attempt++) {
        throwIfAborted(signal);
        heartbeat?.(`Browser navigation attempt ${attempt + 1}`);
        try {
          const page = this.activePage;
          const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: NAVIGATION_TIMEOUT,
          });
          if (response && response.status() >= 400) {
            throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
          }

          try {
            await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT });
          } catch (err) {
            console.warn(`[BrowserTool] networkidle timeout:`, err);
          }
          throwIfAborted(signal);

          // Human-like post-navigation behavior
          await delayWithSignal(
            Math.floor(Math.random() * (DELAY_MEDIUM[1] - DELAY_MEDIUM[0] + 1)) + DELAY_MEDIUM[0],
            signal,
          );
          await this.randomScroll();
          await delayWithSignal(Math.floor(Math.random() * 701) + 500, signal);

          const title = await this.activePage.title();
          const currentUrl = this.activePage.url();
          await this.assertAutonomousDomain(currentUrl);
          this.navCount++;
          if (this.navCount % this.maxNavigationsBeforeClear === 0) {
            await this.rotatePresentation();
            this.navCount = 0;
          }
          return `Successfully navigated to: ${currentUrl}\nTitle: ${title}`;
        } catch (error: unknown) {
          throwIfAborted(signal);
          lastError = getErrorMessage(error);
          console.warn(`[BrowserTool] Navigation attempt ${attempt + 1} failed: ${lastError}`);

          const httpStatus = Number(lastError.match(/^HTTP (\d{3}):/)?.[1]);
          const permanentHttpFailure = Number.isFinite(httpStatus)
            && httpStatus > 0
            && httpStatus < 500
            && ![408, 425, 429].includes(httpStatus);
          if (permanentHttpFailure || attempt >= maxAttempts) {
            // Permanent HTTP responses (for example 401/403/404/422) are not transient.
            try {
              const currentUrl = this.activePage.url();
              const title = await this.activePage.title();
              return `Navigation failed after ${attempt + 1} attempts. Current URL: ${currentUrl}, Title: ${title}. Last Error: ${lastError}`;
            } catch {
              return `Navigation failed after ${attempt + 1} attempts. Last Error: ${lastError}`;
            }
          }

          // Close stale page before retry to prevent memory leaks.
          try {
            if (this.page && !this.page.isClosed()) await this.page.close();
          } catch {
            // Best-effort close.
          }
          this.page = null;
          await this.rotatePresentation();
          // Exponential backoff with a bounded delay and jitter; retry count is not a goal limit.
          const backoff = Math.min(60_000, 2_000 * (2 ** Math.min(attempt, 5)));
          await delayWithSignal(backoff + Math.floor(Math.random() * Math.max(1_000, backoff * 0.25)), signal);
        }
      }
      return `Error: Navigation to ${url} failed${lastError ? `: ${lastError}` : "."}`;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      signal?.removeEventListener("abort", abortPage);
    }
  }

  public async click(selector: string): Promise<string> {
    await this.ensureLaunched();
    try {
      const pwSelector = this.toPlaywrightSelector(selector);
      const page = this.activePage;
      await this.assertAutonomousDomain(page.url());
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
      await this.assertAutonomousDomain(page.url());
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
      await this.assertAutonomousDomain(page.url());
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
      await this.assertAutonomousDomain(page.url());
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
      await this.assertAutonomousDomain(this.activePage.url());
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

  public setWorkspaceDir(workspaceDir: string): void {
    const normalized = workspaceDir.trim();
    this.workspaceDir = normalized ? path.resolve(normalized) : null;
  }

  public async screenshot(destinationPath?: string): Promise<string> {
    await this.ensureLaunched();
    try {
      await this.assertAutonomousDomain(this.activePage.url());
      const requested = destinationPath?.trim();
      let filepath: string;
      if (requested) {
        if (!this.workspaceDir) {
          throw new Error("Screenshot workspace is not configured");
        }
        const candidate = path.resolve(
          this.workspaceDir,
          path.isAbsolute(requested)
            ? path.relative(this.workspaceDir, requested)
            : requested,
        );
        const relative = path.relative(this.workspaceDir, candidate);
        if (
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          !/\.png$/i.test(candidate)
        ) {
          throw new Error(
            "Screenshot path must be a .png file inside the workspace",
          );
        }
        filepath = candidate;
        fs.mkdirSync(path.dirname(filepath), { recursive: true });
      } else {
        const filename =
          "screenshot_" +
          crypto.randomUUID().replace(/-/g, "").slice(0, 8) +
          ".png";
        filepath = path.join(this.screenshotDir, filename);
      }
      await this.activePage.screenshot({ path: filepath, fullPage: false });
      return "Screenshot saved to: " + filepath;
    } catch (e: unknown) {
      return "Error taking screenshot: " + getErrorMessage(e);
    }
  }

  private async _launchPlaywright(): Promise<BrowserContext> {
    try {
      const { chromium } = await import("playwright");
      const executablePath =
        this._chromePath ||
        [
          process.env.CHROME_PATH,
          process.env.CHROMIUM_PATH,
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ].find((candidate) => candidate && fs.existsSync(candidate));
      // Playwright recommends launchPersistentContext for using a specific user data directory
      return await chromium.launchPersistentContext(this.profileDir, {
        headless: this.headless,
        executablePath: executablePath || undefined,
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
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        "Chromium is not installed or could not be launched. " +
          "Run `npx playwright install chromium` and retry. " +
          `Original error: ${detail}`,
        { cause: err },
      );
    }
  }

  public async playMedia(url?: string): Promise<string> {
    await this.ensureLaunched();
    try {
      const page = this.activePage;
      const mediaUrl = url ? normalizeBrowserUrl(url) : page.url();
      if (url) {
        await page.goto(mediaUrl, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT,
        });
      }
      const state = await page.evaluate(async (source) => {
        const doc = (
          globalThis as unknown as { document: BrowserMediaDocument }
        ).document;
        const win = globalThis as unknown as {
          setTimeout(handler: () => void, timeout: number): number;
          clearTimeout(handle: number): void;
        };
        let media = doc.querySelector("video, audio");
        if (!media) {
          media = doc.createElement("video");
          media.controls = true;
          media.playsInline = true;
          media.muted = true;
          if (media.style) media.style.maxWidth = "100%";
          doc.body.appendChild(media);
        }
        if (source && media.currentSrc !== source && media.src !== source) {
          media.src = source;
          media.load?.();
        }
        media.muted = true;
        if (typeof media.play !== "function") {
          throw new Error(
            "Current page does not expose a playable media element",
          );
        }
        await media.play();
        if (media.readyState < 2) {
          await new Promise<void>((resolve, reject) => {
            const timer = win.setTimeout(
              () => reject(new Error("Media did not become ready to play")),
              10000,
            );
            if (typeof media?.addEventListener !== "function") {
              reject(new Error("Media readiness events are unavailable"));
              return;
            }
            media.addEventListener(
              "canplay",
              () => {
                win.clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
        return {
          tag: media.tagName.toLowerCase(),
          src: media.currentSrc || media.src,
          readyState: media.readyState,
          paused: media.paused,
          currentTime: media.currentTime,
          duration: Number.isFinite(media.duration) ? media.duration : null,
        };
      }, mediaUrl);
      if (state.readyState < 2 || state.paused) {
        throw new Error("Media did not reach a verified playing state");
      }
      return JSON.stringify({ verified: true, media: state });
    } catch (e: unknown) {
      return JSON.stringify({ verified: false, error: getErrorMessage(e) });
    }
  }

  public async close(): Promise<string> {
    if (this.workspacePreviewServer) {
      await new Promise<void>((resolve) =>
        this.workspacePreviewServer?.close(() => resolve()),
      );
      this.workspacePreviewServer = null;
      this.workspacePreviewRoot = null;
      this.workspacePreviewPort = null;
    }
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

  /**
   * Varies presentation without destroying the persistent browser profile.
   * Cookies, local storage and authenticated sessions are never cleared by
   * routine navigation or recovery. The user-agent change applies on the next
   * cold launch; viewport changes are applied to current live pages.
   */
  public async rotatePresentation(): Promise<void> {
    this.userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    this.viewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
    if (this.context) {
      for (const page of this.context.pages()) {
        if (page.isClosed()) continue;
        try { await page.setViewportSize(this.viewport); }
        catch (error) { console.warn(`[BrowserTool] viewport update failed: ${getErrorMessage(error)}`); }
      }
    }
    this.persistSessionCheckpoint();
  }

  public toPlaywrightSelector(selector: string): string {
    if (selector.startsWith("//") || selector.startsWith("(//"))
      return "xpath=" + selector;
    if (selector.startsWith("text=") || selector.startsWith("xpath="))
      return selector;
    return selector;
  }
}
