const api = globalThis.browser || globalThis.chrome;
const state = document.getElementById("state");
api.storage.local.get(["mikiBridgeUrl", "mikiBridgeToken"]).then((value) => {
  state.textContent = value.mikiBridgeUrl && value.mikiBridgeToken ? "Pairing saved. Check the Miki dashboard for connection status." : "Not paired. Open settings and enter the URL and token from Miki.";
});
document.getElementById("settings").addEventListener("click", () => api.runtime.openOptionsPage());
