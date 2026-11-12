import * as path from "node:path";
import * as fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { validateNetworkUrl } from "../../autonomy/network-security.js";
import { getErrorMessage } from "../../errors.js";

export interface BrowserConfig {
  bridgePort?: number;
  requestTimeoutMs?: number;
  allowPrivateNetworks?: boolean;
}

export interface BrowserReconciliationSnapshot {
  browserAvailable: boolean;
  connectedBrowserCount: number;
  activeBrowser: string;
  activeUrl: string;
  tabCount: number;
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

interface BrowserTab {
  id: number;
  windowId?: number;
  active?: boolean;
  title?: string;
  url?: string;
  status?: string;
}

interface BrowserClient {
  id: string;
  name: string;
  version: string;
  userAgent: string;
  socket: WebSocket;
  connectedAt: string;
  activeTabId?: number;
  activeUrl: string;
  tabs: BrowserTab[];
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const DEFAULT_BRIDGE_PORT = 18765;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;

export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("URL is required");
  if (/^(?:javascript|data|file|vbscript):/i.test(trimmed)) {
    throw new Error("Unsupported browser URL protocol");
  }
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try { parsed = new URL(candidate); }
  catch { throw new Error("Invalid browser URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Browser URL must use http:// or https://");
  }
  return parsed.toString();
}

/** Retained for workspace preview callers; it does not start a browser process. */
export function rewriteWorkspacePreviewUrl(input: string, ownedPort: number): string {
  const parsed = new URL(normalizeBrowserUrl(input));
  if ((parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === "8765") {
    parsed.port = String(ownedPort);
  }
  return parsed.toString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Browser operation was cancelled.");
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * BrowserTool is a browser-extension bridge, not a bundled browser runtime.
 * The extension uses the WebExtensions API, so the same Agent can operate
 * Chrome, Edge, Brave, Opera, Vivaldi, Chromium and Firefox installations.
 * Safari and browsers without WebExtensions remain available through the OS
 * accessibility backend when the host OS exposes their windows and controls.
 */
export class BrowserTool {
  private readonly dataDir: string;
  private readonly tokenPath: string;
  private readonly requestTimeoutMs: number;
  private readonly configuredPort: number;
  private server: WebSocketServer | null = null;
  private serverStarting: Promise<void> | null = null;
  private bridgePort = 0;
  private bridgeToken = "";
  private clients = new Map<string, BrowserClient>();
  private pending = new Map<string, PendingRequest>();
  private connectionWaiters = new Set<(client?: BrowserClient, error?: Error) => void>();
  private activeBrowserId = "";
  private activeTabId: number | undefined;
  private workspaceDir: string | null = null;
  private allowedDomains: string[] = [];
  private allowPrivateNetworks = false;
  private lastKnownPageUrl = "";

  constructor(_headless = false, dataDir = "data", _profileManager?: unknown, config?: BrowserConfig) {
    this.dataDir = path.resolve(dataDir);
    this.tokenPath = path.join(this.dataDir, "browser-bridge-token");
    const environmentPort = process.env.MIKI_BROWSER_BRIDGE_PORT === undefined
      ? DEFAULT_BRIDGE_PORT
      : Number(process.env.MIKI_BROWSER_BRIDGE_PORT);
    const requestedPort = config?.bridgePort ?? environmentPort;
    this.configuredPort = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65_535
      ? requestedPort
      : DEFAULT_BRIDGE_PORT;
    this.requestTimeoutMs = Math.max(1_000, Math.min(120_000, config?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
    this.allowPrivateNetworks = config?.allowPrivateNetworks === true;
  }

  private loadOrCreateToken(): string {
    if (this.bridgeToken) return this.bridgeToken;
    fs.mkdirSync(this.dataDir, { recursive: true });
    try {
      const existing = fs.readFileSync(this.tokenPath, "utf8").trim();
      if (/^[a-f0-9]{64}$/i.test(existing)) {
        this.bridgeToken = existing;
        return existing;
      }
    } catch { /* create a new owner-only pairing token */ }
    this.bridgeToken = crypto.randomBytes(32).toString("hex");
    const temporary = `${this.tokenPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${this.bridgeToken}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.tokenPath);
    try { fs.chmodSync(this.tokenPath, 0o600); } catch { /* Windows ACLs are managed by the OS. */ }
    return this.bridgeToken;
  }

  private async ensureBridge(): Promise<void> {
    if (this.server) return;
    if (this.serverStarting) return this.serverStarting;
    this.serverStarting = new Promise<void>((resolve, reject) => {
      const token = this.loadOrCreateToken();
      const server = new WebSocketServer({ host: "127.0.0.1", port: this.configuredPort, maxPayload: MAX_MESSAGE_BYTES });
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(new Error(`Browser bridge could not listen on 127.0.0.1:${this.configuredPort}: ${error.message}`));
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Browser bridge did not expose a TCP listening port."));
          return;
        }
        this.bridgePort = address.port;
        this.server = server;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.on("connection", (socket, request) => {
        const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
        if (url.pathname !== "/miki-browser") {
          socket.close(1008, "Unknown browser bridge endpoint");
          return;
        }
        const supplied = url.searchParams.get("token") || "";
        const origin = String(request.headers.origin || "");
        const validOrigin = /^(chrome-extension|moz-extension|safari-web-extension):\/\//i.test(origin);
        const tokenShapeValid = /^[a-f0-9]{64}$/i.test(supplied);
        const tokenMatches = tokenShapeValid && supplied.length === token.length
          && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
        if (!tokenMatches || !validOrigin || !isLoopback(request.socket.remoteAddress)) {
          socket.close(1008, "Browser bridge pairing rejected");
          return;
        }
        this.handleClient(socket);
      });
    }).finally(() => { this.serverStarting = null; });
    return this.serverStarting;
  }

  private handleClient(socket: WebSocket): void {
    let clientId = "";
    socket.on("message", (raw) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; }
      catch { socket.close(1003, "Invalid JSON"); return; }
      const type = String(message.type || "");
      if (type === "browser.hello") {
        const id = String(message.browserId || "").trim().slice(0, 120);
        if (!id) { socket.close(1008, "browserId is required"); return; }
        clientId = id;
        const prior = this.clients.get(id);
        if (prior && prior.socket !== socket) prior.socket.close(4001, "Replaced by a newer browser connection");
        const client: BrowserClient = {
          id,
          name: String(message.browserName || "Browser").slice(0, 80),
          version: String(message.version || "").slice(0, 80),
          userAgent: String(message.userAgent || "").slice(0, 300),
          socket,
          connectedAt: new Date().toISOString(),
          activeUrl: "",
          tabs: [],
        };
        this.clients.set(id, client);
        if (!this.activeBrowserId || !this.clients.has(this.activeBrowserId)) this.activeBrowserId = id;
        for (const waiter of [...this.connectionWaiters]) waiter(client);
        socket.send(JSON.stringify({ type: "browser.ready", protocol: "miki.browser.v1" }));
        return;
      }
      if (!clientId) { socket.close(1008, "Send browser.hello first"); return; }
      const client = this.clients.get(clientId);
      if (!client || client.socket !== socket) return;
      if (type === "browser.ping") {
        socket.send(JSON.stringify({ type: "browser.pong", at: Date.now() }));
        return;
      }
      if (type === "browser.state") {
        const tab = asRecord(message.activeTab);
        client.activeTabId = Number.isInteger(tab.id) ? Number(tab.id) : client.activeTabId;
        client.activeUrl = typeof tab.url === "string" ? tab.url : client.activeUrl;
        client.tabs = Array.isArray(message.tabs) ? message.tabs.map((value) => {
          const item = asRecord(value);
          return {
            id: Number(item.id),
            ...(Number.isInteger(item.windowId) ? { windowId: Number(item.windowId) } : {}),
            active: item.active === true,
            title: typeof item.title === "string" ? item.title.slice(0, 500) : "",
            url: typeof item.url === "string" ? item.url.slice(0, 4_000) : "",
            status: typeof item.status === "string" ? item.status : "",
          };
        }).filter((tab) => Number.isInteger(tab.id)) : client.tabs;
        if (clientId === this.activeBrowserId) {
          this.activeTabId = client.activeTabId;
          this.lastKnownPageUrl = client.activeUrl;
        }
        return;
      }
      if (type === "rpc.result") {
        const id = String(message.id || "");
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener("abort", pending.onAbort!);
        this.pending.delete(id);
        if (message.ok === false) pending.reject(new Error(String(message.error || "Browser extension action failed.")));
        else pending.resolve(message.result);
      }
    });
    socket.on("close", () => {
      if (clientId) {
        const current = this.clients.get(clientId);
        if (current?.socket === socket) this.clients.delete(clientId);
        if (this.activeBrowserId === clientId && !this.clients.has(clientId)) {
          this.activeBrowserId = this.clients.keys().next().value || "";
          this.activeTabId = undefined;
          this.lastKnownPageUrl = this.clients.get(this.activeBrowserId)?.activeUrl || "";
        }
      }
      for (const [id, pending] of this.pending) {
        if (!clientId || id.startsWith(`${clientId}:`)) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Browser extension disconnected while an action was running."));
          this.pending.delete(id);
        }
      }
    });
    socket.on("error", () => undefined);
  }

  private selectedClient(): BrowserClient {
    const client = this.clients.get(this.activeBrowserId) || this.clients.values().next().value as BrowserClient | undefined;
    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      throw new Error("No browser extension is connected. Install and pair the Miki Browser Agent extension in Chrome, Edge, Brave, Opera, Vivaldi, Chromium or Firefox.");
    }
    return client;
  }

  private async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    await this.ensureBridge();
    const client = this.selectedClient();
    const id = `${client.id}:${crypto.randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser action '${method}' timed out after ${this.requestTimeoutMs} ms.`));
      }, this.requestTimeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        try { client.socket.send(JSON.stringify({ type: "rpc.cancel", id })); } catch { /* disconnected */ }
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Browser operation was cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      try {
        client.socket.send(JSON.stringify({ type: "rpc.request", id, method, params: { ...params, ...(this.activeTabId != null && !Object.prototype.hasOwnProperty.call(params, "tabId") ? { tabId: this.activeTabId } : {}) } }));
      } catch (error) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public setBypassRestrictions(enabled: boolean): void {
    this.allowPrivateNetworks = enabled;
    if (enabled) this.allowedDomains = [];
  }

  public setAllowedDomains(domains: string[]): void {
    this.allowedDomains = domains.map((domain) => domain.trim().toLowerCase().replace(/^\.+|\.+$/g, "")).filter(Boolean);
  }

  public getSecurityPolicySnapshot(): { allowPrivateNetworks: boolean; allowedDomains: string[] } {
    return { allowPrivateNetworks: this.allowPrivateNetworks, allowedDomains: [...this.allowedDomains] };
  }

  public setWorkspaceDir(workspaceDir: string): void {
    const normalized = workspaceDir.trim();
    this.workspaceDir = normalized ? path.resolve(normalized) : null;
  }

  private async validateUrl(input: string): Promise<string> {
    const normalized = normalizeBrowserUrl(input);
    const validated = await validateNetworkUrl(normalized, {
      allowedDomains: this.allowedDomains,
      allowPrivateNetworks: this.allowPrivateNetworks,
    });
    return validated.toString();
  }

  public currentUrl(): string { return this.lastKnownPageUrl; }

  public async ensureLaunched(): Promise<void> { await this.ensureBridge(); }

  public async waitForBrowserConnection(timeoutMs = 30_000, signal?: AbortSignal, expectedBrowserName?: string): Promise<Record<string, unknown>> {
    throwIfAborted(signal);
    await this.ensureBridge();
    const expected = expectedBrowserName?.trim().toLocaleLowerCase();
    const matches = (client: BrowserClient) => !expected || client.name.toLocaleLowerCase().includes(expected);
    const current = [...this.clients.values()].find((client) => client.socket.readyState === WebSocket.OPEN && matches(client));
    if (current) return { id: current.id, name: current.name, connectedAt: current.connectedAt };
    const timeout = Math.max(1_000, Math.min(120_000, Math.floor(timeoutMs)));
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      const finish = (client?: BrowserClient, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connectionWaiters.delete(onConnected);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else if (client) resolve({ id: client.id, name: client.name, connectedAt: client.connectedAt });
        else reject(new Error("Browser connection ended without a client."));
      };
      const onConnected = (client?: BrowserClient, error?: Error) => {
        if (error) finish(undefined, error);
        else if (client && matches(client)) finish(client);
      };
      const onAbort = () => finish(undefined, signal?.reason instanceof Error ? signal.reason : new Error("Browser connection wait was cancelled."));
      const timer = setTimeout(() => finish(undefined, new Error(`No ${expectedBrowserName || "browser"} Miki Browser Agent extension connected before the deadline. Install and pair the extension in the selected browser, then retry.`)), timeout);
      this.connectionWaiters.add(onConnected);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  public async getBridgeInfo(): Promise<Record<string, unknown>> {
    await this.ensureBridge();
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const sourceExtensionDirectory = path.join(moduleDirectory, "extension");
    const extensionCandidates = [
      sourceExtensionDirectory,
      path.resolve(moduleDirectory, "../../../dist/plugins/browser/extension"),
      path.resolve(process.cwd(), "packages/core/dist/plugins/browser/extension"),
    ];
    const builtExtensionDirectory = extensionCandidates.find((candidate) =>
      fs.existsSync(path.join(candidate, "chrome", "manifest.json"))
      && fs.existsSync(path.join(candidate, "firefox", "manifest.json")),
    );
    const extensionDirectory = builtExtensionDirectory || sourceExtensionDirectory;
    const installTargets = builtExtensionDirectory ? {
      chrome: path.join(builtExtensionDirectory, "chrome"),
      firefox: path.join(builtExtensionDirectory, "firefox"),
      safari: path.join(builtExtensionDirectory, "safari"),
    } : {};
    return {
      protocol: "miki.browser.v1",
      wsUrl: `ws://127.0.0.1:${this.bridgePort}/miki-browser`,
      token: this.loadOrCreateToken(),
      connectedBrowsers: this.listBrowsers(),
      extensionDirectory,
      extensionSourceDirectory: sourceExtensionDirectory,
      extensionBuildRequired: !builtExtensionDirectory,
      installTargets,
      supportedFamilies: ["Chrome", "Microsoft Edge", "Brave", "Opera", "Vivaldi", "Chromium", "Firefox", "Safari (requires Xcode packaging on macOS)"],
      notes: ["Install and pair the Miki extension separately in each WebExtensions-compatible browser.", "Safari source is included but must be converted into a signed Safari Web Extension app with Xcode before installation.", "Browsers without compatible extension APIs can only be controlled through the host OS accessibility backend, where exposed controls may be limited."],
    };
  }

  public listBrowsers(): Array<Record<string, unknown>> {
    return [...this.clients.values()].map((client) => ({
      id: client.id, name: client.name, version: client.version, userAgent: client.userAgent,
      connectedAt: client.connectedAt, active: client.id === this.activeBrowserId,
      tabCount: client.tabs.length, activeUrl: client.activeUrl,
    }));
  }

  public async listTabs(browserId?: string): Promise<string> {
    if (browserId && browserId !== this.activeBrowserId) await this.selectBrowser(browserId);
    const tabs = await this.rpc<BrowserTab[]>("tabs.list");
    const client = this.selectedClient();
    client.tabs = Array.isArray(tabs) ? tabs : [];
    return JSON.stringify({ browser: { id: client.id, name: client.name }, tabs: client.tabs }, null, 2);
  }

  public async selectBrowser(browserId: string): Promise<string> {
    const client = this.clients.get(browserId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) throw new Error(`Browser '${browserId}' is not connected.`);
    this.activeBrowserId = browserId;
    this.activeTabId = client.activeTabId;
    this.lastKnownPageUrl = client.activeUrl;
    return `Selected ${client.name} (${client.id}).`;
  }

  public async selectTab(tabId: number, browserId?: string): Promise<string> {
    if (browserId && browserId !== this.activeBrowserId) await this.selectBrowser(browserId);
    const result = asRecord(await this.rpc("tabs.activate", { tabId }));
    this.activeTabId = tabId;
    if (typeof result.url === "string") this.lastKnownPageUrl = result.url;
    return `Selected browser tab ${tabId}${typeof result.title === "string" ? `: ${result.title}` : ""}.`;
  }

  public async navigate(url: string, _retries?: number, signal?: AbortSignal, heartbeat?: (detail?: string) => void): Promise<string> {
    throwIfAborted(signal);
    const safeUrl = await this.validateUrl(url);
    heartbeat?.("Sending navigation request to the selected browser.");
    const result = asRecord(await this.rpc("tabs.navigate", { url: safeUrl }, signal));
    if (Number.isInteger(result.tabId)) this.activeTabId = Number(result.tabId);
    this.lastKnownPageUrl = typeof result.url === "string" ? result.url : safeUrl;
    return `Opened in ${this.selectedClient().name}: ${this.lastKnownPageUrl}${typeof result.title === "string" ? `\nTitle: ${result.title}` : ""}`;
  }

  public async click(selector: string): Promise<string> {
    await this.assertCurrentPageAllowed();
    const result = await this.rpc("dom.click", { selector });
    return `Clicked browser element. ${typeof result === "string" ? result : JSON.stringify(result ?? {})}`;
  }

  public async type(selector: string, text: string, enter = false): Promise<string> {
    if (text.length > 4_000) throw new Error("Browser text input exceeds the 4,000 character limit.");
    await this.assertCurrentPageAllowed();
    const result = await this.rpc("dom.type", { selector, text, enter });
    return `Entered text into browser field. ${typeof result === "string" ? result : JSON.stringify(result ?? {})}`;
  }

  public async invoke(target: BrowserSemanticTarget): Promise<string> {
    await this.assertCurrentPageAllowed();
    const result = await this.rpc("dom.invoke", { target });
    return `Invoked browser element. ${typeof result === "string" ? result : JSON.stringify(result ?? {})}`;
  }

  public async fill(target: BrowserSemanticTarget, text: string, enter = false): Promise<string> {
    const selector = target.selector || (target.role ? `role=${target.role}[name=${target.name || target.text || ""}]` : target.label ? `label=${target.label}` : target.placeholder ? `placeholder=${target.placeholder}` : target.text ? `text=${target.text}` : "");
    return this.type(selector, text, enter);
  }

  public async press(target: BrowserSemanticTarget | undefined, key: string): Promise<string> {
    await this.assertCurrentPageAllowed();
    const result = await this.rpc("dom.press", { target, key });
    return `Dispatched browser key event '${key}'. ${typeof result === "string" ? result : JSON.stringify(result ?? {})}`;
  }

  public async extract(selector?: string): Promise<string> {
    await this.assertCurrentPageAllowed();
    const result = asRecord(await this.rpc("dom.extract", { selector }));
    if (typeof result.url === "string") this.lastKnownPageUrl = result.url;
    return `URL: ${String(result.url || this.lastKnownPageUrl)}\nTitle: ${String(result.title || "")}\n\n${String(result.text || "(no visible text)")}`;
  }

  public async getHtml(): Promise<string> { return this.extract(); }
  public async getUrl(): Promise<string> { return this.lastKnownPageUrl; }

  public async scrollDown(pixels = 500): Promise<string> {
    await this.assertCurrentPageAllowed();
    await this.rpc("dom.scroll", { direction: "down", pixels: Math.max(1, Math.min(5_000, Math.floor(pixels))) });
    return `Scrolled down ${pixels}px.`;
  }

  public async scrollToBottom(): Promise<string> {
    await this.assertCurrentPageAllowed();
    await this.rpc("dom.scroll", { direction: "bottom" });
    return "Scrolled to bottom of page.";
  }

  public async screenshot(destinationPath?: string): Promise<string> {
    await this.assertCurrentPageAllowed();
    const result = asRecord(await this.rpc("screen.capture", {}));
    const dataUrl = typeof result.dataUrl === "string" ? result.dataUrl : "";
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) throw new Error("The browser extension did not return a valid PNG screenshot.");
    const requested = destinationPath?.trim();
    let filepath: string;
    if (requested) {
      if (!this.workspaceDir) throw new Error("Screenshot workspace is not configured.");
      filepath = path.resolve(this.workspaceDir, requested);
      const relative = path.relative(this.workspaceDir, filepath);
      if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.png$/i.test(filepath)) {
        throw new Error("Screenshot path must be a .png file inside the workspace.");
      }
    } else {
      filepath = path.join(this.dataDir, "screenshots", `browser_${crypto.randomUUID().slice(0, 8)}.png`);
    }
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, Buffer.from(match[1], "base64"), { mode: 0o600 });
    return `Browser screenshot saved to: ${filepath}`;
  }

  private async assertCurrentPageAllowed(): Promise<void> {
    const url = this.currentUrl();
    if (!url || !/^https?:\/\//i.test(url)) throw new Error("No active HTTP(S) browser page is selected. Call browser_navigate first.");
    await this.validateUrl(url);
  }

  public async reconcileAfterCrash(): Promise<BrowserReconciliationSnapshot> {
    await this.ensureBridge();
    const browsers = this.listBrowsers();
    let tabs: BrowserTab[] = [];
    let activeUrl = this.lastKnownPageUrl;
    let activeName = "";
    if (browsers.length) {
      const client = this.selectedClient();
      activeName = client.name;
      try { tabs = JSON.parse(await this.listTabs())?.tabs ?? []; } catch { tabs = client.tabs; }
      activeUrl = client.activeUrl || activeUrl;
    }
    return {
      browserAvailable: browsers.length > 0,
      connectedBrowserCount: browsers.length,
      activeBrowser: activeName,
      activeUrl,
      tabCount: tabs.length,
      reconciledAt: new Date().toISOString(),
      restoredFromCheckpoint: Boolean(activeUrl),
    };
  }

  public async close(): Promise<string> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort!);
      pending.reject(new Error("Browser bridge is shutting down."));
    }
    this.pending.clear();
    for (const waiter of [...this.connectionWaiters]) waiter(undefined, new Error("Browser bridge stopped before the browser connected."));
    this.connectionWaiters.clear();
    for (const client of this.clients.values()) client.socket.close(1001, "Miki gateway shutdown");
    this.clients.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.bridgePort = 0;
    this.activeBrowserId = "";
    this.activeTabId = undefined;
    return "Browser bridge stopped; user browser processes were left running.";
  }
}
