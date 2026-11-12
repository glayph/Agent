const api = globalThis.browser || globalThis.chrome;
const urlField = document.getElementById("url");
const tokenField = document.getElementById("token");
const status = document.getElementById("status");
api.storage.local.get(["mikiBridgeUrl", "mikiBridgeToken"]).then((value) => {
  urlField.value = value.mikiBridgeUrl || "";
  tokenField.value = value.mikiBridgeToken || "";
});
document.getElementById("save").addEventListener("click", async () => {
  const url = urlField.value.trim();
  const token = tokenField.value.trim();
  if (!/^ws:\/\/127\.0\.0\.1:\d+\/miki-browser$/.test(url)) { status.textContent = "Use the loopback WebSocket URL from Miki's dashboard."; return; }
  if (!/^[a-f0-9]{64}$/i.test(token)) { status.textContent = "The pairing token must be 64 hexadecimal characters."; return; }
  await api.storage.local.set({ mikiBridgeUrl: url, mikiBridgeToken: token });
  status.textContent = "Saved. The extension is reconnecting to Miki.";
});
