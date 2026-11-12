/* Shared Chromium / Firefox WebExtensions background worker. */
const api = globalThis.browser || globalThis.chrome;
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let browserId = "";
let heartbeatTimer = null;

const storageGet = async (keys) => api.storage.local.get(keys);
const storageSet = async (value) => api.storage.local.set(value);
const isConnected = () => socket && socket.readyState === WebSocket.OPEN;
const send = (message) => { if (isConnected()) socket.send(JSON.stringify(message)); };

async function getBrowserIdentity() {
  const stored = await storageGet(["mikiBrowserId", "mikiBrowserName"]);
  if (!stored.mikiBrowserId) {
    browserId = crypto.randomUUID();
    await storageSet({ mikiBrowserId: browserId });
  } else browserId = stored.mikiBrowserId;
  let name = stored.mikiBrowserName || "Browser";
  const ua = navigator.userAgent;
  if (/Firefox\//i.test(ua)) name = "Firefox";
  else if (/Edg\//i.test(ua)) name = "Microsoft Edge";
  else if (/OPR\//i.test(ua)) name = "Opera";
  else if (/Vivaldi\//i.test(ua)) name = "Vivaldi";
  else if (/Brave/i.test(ua) || (navigator.brave && await navigator.brave.isBrave?.())) name = "Brave";
  else if (/Chrome\//i.test(ua)) name = "Chrome / Chromium";
  else if (/Safari\//i.test(ua)) name = "Safari";
  return { name, ua };
}

async function sendState() {
  if (!isConnected()) return;
  try {
    const allTabs = await api.tabs.query({});
    const activeTabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
    const active = activeTabs[0] || null;
    send({ type: "browser.state", activeTab: active ? { id: active.id, url: active.url || "" } : {}, tabs: allTabs.map((tab) => ({ id: tab.id, windowId: tab.windowId, active: tab.active, title: tab.title || "", url: tab.url || "", status: tab.status || "" })) });
  } catch { /* browser may be shutting down */ }
}

async function ensureContentScript(tabId) {
  try {
    if (api.scripting?.executeScript) await api.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    else if (api.tabs?.executeScript) await api.tabs.executeScript(tabId, { file: "content.js" });
  } catch { /* already injected, restricted page, or extension permission denied; sendMessage reports the useful error */ }
}
async function callContent(tabId, action, payload) {
  await ensureContentScript(tabId);
  return api.tabs.sendMessage(tabId, { source: "miki-browser-agent", action, payload });
}
async function currentTab(params) {
  if (Number.isInteger(params.tabId)) {
    const tab = await api.tabs.get(params.tabId);
    if (tab) return tab;
  }
  const tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs[0]?.id) throw new Error("No active browser tab is available.");
  return tabs[0];
}

async function handleRequest(message) {
  const params = message.params || {};
  switch (message.method) {
    case "tabs.list": {
      const tabs = await api.tabs.query({});
      return tabs.map((tab) => ({ id: tab.id, windowId: tab.windowId, active: tab.active, title: tab.title || "", url: tab.url || "", status: tab.status || "" }));
    }
    case "tabs.navigate": {
      let tab;
      if (Number.isInteger(params.tabId)) tab = await api.tabs.update(params.tabId, { url: params.url, active: true });
      else tab = await api.tabs.create({ url: params.url, active: true });
      await sendState();
      return { tabId: tab.id, url: tab.url || params.url, title: tab.title || "" };
    }
    case "tabs.activate": {
      const tab = await api.tabs.update(Number(params.tabId), { active: true });
      if (Number.isInteger(tab.windowId)) await api.windows.update(tab.windowId, { focused: true });
      await sendState();
      return { tabId: tab.id, url: tab.url || "", title: tab.title || "" };
    }
    case "tabs.close":
      await api.tabs.remove(Number(params.tabId));
      await sendState();
      return { closed: true };
    case "dom.snapshot": case "dom.extract": case "dom.click": case "dom.type": case "dom.invoke": case "dom.press": case "dom.scroll": {
      const tab = await currentTab(params);
      const action = message.method.slice(4);
      const result = await callContent(tab.id, action, params);
      await sendState();
      return result;
    }
    case "screen.capture": {
      const tab = await currentTab(params);
      const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { dataUrl };
    }
    default: throw new Error(`Unsupported Miki browser request '${message.method}'.`);
  }
}

async function onSocketMessage(event) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === "browser.ready") { await sendState(); return; }
  if (message.type !== "rpc.request") return;
  try {
    const result = await handleRequest(message);
    send({ type: "rpc.result", id: message.id, ok: true, result });
  } catch (error) {
    send({ type: "rpc.result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function connect() {
  const settings = await storageGet(["mikiBridgeUrl", "mikiBridgeToken"]);
  if (!settings.mikiBridgeUrl || !settings.mikiBridgeToken) return;
  const identity = await getBrowserIdentity();
  const url = new URL(settings.mikiBridgeUrl);
  url.searchParams.set("token", settings.mikiBridgeToken);
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const connection = new WebSocket(url.toString());
  socket = connection;
  connection.addEventListener("open", () => {
    if (socket !== connection) return;
    reconnectDelay = 1000;
    send({ type: "browser.hello", browserId, browserName: identity.name, userAgent: identity.ua, version: api.runtime.getManifest().version });
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => send({ type: "browser.ping", at: Date.now() }), 20_000);
  });
  connection.addEventListener("message", onSocketMessage);
  connection.addEventListener("close", () => scheduleReconnect(connection));
  connection.addEventListener("error", () => connection.close());
}
function scheduleReconnect(connection) {
  if (socket !== connection) return;
  socket = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(30_000, reconnectDelay * 2);
    void connect();
  }, reconnectDelay);
}

api.runtime.onInstalled.addListener(() => { void connect(); });
api.runtime.onStartup?.addListener(() => { void connect(); });
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.mikiBridgeUrl || changes.mikiBridgeToken)) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const previous = socket;
    socket = null;
    previous?.close();
    void connect();
  }
});
api.tabs.onCreated.addListener(() => { void sendState(); });
api.tabs.onRemoved.addListener(() => { void sendState(); });
api.tabs.onActivated.addListener(() => { void sendState(); });
api.tabs.onUpdated.addListener((_id, changeInfo) => { if (changeInfo.status === "complete" || changeInfo.url) void sendState(); });
api.windows.onFocusChanged.addListener(() => { void sendState(); });
void connect();
