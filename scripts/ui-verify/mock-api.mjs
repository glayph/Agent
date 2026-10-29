// In-memory mock of the gateway REST API used by the browser verification.
export function createMockState() {
  return {
    channels: [
      { name: "telegram", display_name: "Telegram", config_key: "telegram", configured: true, runtime_status: "functional", runtime_live: true, runtime_connected: true },
      { name: "discord", display_name: "Discord", config_key: "discord", configured: false, runtime_status: "functional", runtime_live: false },
      { name: "slack", display_name: "Slack", config_key: "slack", configured: true, runtime_status: "functional", runtime_live: true, runtime_connected: false, runtime_error: "invalid_auth" },
      { name: "feishu", display_name: "Feishu", config_key: "feishu", configured: false, runtime_status: "partial", runtime_note: "Configuration and validation are managed by the dashboard." },
      { name: "weixin", display_name: "Weixin", config_key: "weixin", configured: false, runtime_status: "partial" },
      { name: "wecom", display_name: "WeCom", config_key: "wecom", configured: false, runtime_status: "partial" },
      { name: "mqtt", display_name: "MQTT", config_key: "mqtt", configured: false, runtime_status: "partial" },
      { name: "irc", display_name: "IRC", config_key: "irc", configured: false, runtime_status: "partial" },
      { name: "whatsapp", display_name: "WhatsApp", config_key: "whatsapp", configured: false, runtime_status: "config_only" },
      { name: "matrix", display_name: "Matrix", config_key: "matrix", configured: false, runtime_status: "partial" },
    ],
    channelConfigs: {
      telegram: { config: { enabled: true, type: "telegram", allow_from: ["42"] }, configured_secrets: ["token"], config_key: "telegram" },
    },
    channelPuts: [],
    probeCalls: [],
    models: [],
    modelPosts: [],
    failModelIds: [],
    sessionMessages: [
      { id: "u1", role: "user", content: "Summarise the repository and run the tests.", created_at: "2026-10-29T09:00:00Z", status: "completed" },
      { id: "a0", role: "assistant", kind: "tool_calls", content: "Tool run_shell: success", run_id: "r1", created_at: "2026-10-29T09:00:03Z",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }, status: "success", duration_ms: 84 },
          { id: "c2", type: "function", function: { name: "run_shell", arguments: "{\"cmd\":\"npm test\"}" }, status: "error", duration_ms: 4210 },
        ] },
      { id: "a1", role: "assistant", content: "The repository is a monorepo. Tests failed in one suite; see the tool call above.", model_name: "gpt-4o", created_at: "2026-10-29T09:00:09Z", status: "completed" },
    ],
    unhandled: new Set(),
  }
}

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })

export async function installMocks(page, state) {
  await page.route("**/api/**", async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname
    const method = req.method()
    if (p === "/api/auth/status") return json(route, { authenticated: true, initialized: true, session_timeout_minutes: 0 })
    if (p === "/api/gateway/status") return json(route, { gateway_status: "running", gateway_start_allowed: true, pid: 1 })
    if (p === "/api/gateway/logs") return json(route, { logs: [], log_total: 0, log_run_id: 1 })
    if (p === "/api/system/version") return json(route, { version: "1.3.14" })
    if (p === "/api/channels/catalog") return json(route, { channels: state.channels })
    let m = p.match(/^\/api\/channels\/([^/]+)\/config$/)
    if (m) {
      const cfg = state.channelConfigs[m[1]] ?? { config: { enabled: false, type: m[1] }, configured_secrets: [], config_key: m[1] }
      return json(route, cfg)
    }
    m = p.match(/^\/api\/channels\/([^/]+)\/secrets$/)
    if (m) return json(route, { secrets: {} })
    m = p.match(/^\/api\/channels\/([^/]+)\/probe$/)
    if (m) {
      const body = method === "POST" ? JSON.parse(req.postData() || "{}") : null
      state.probeCalls.push({ channel: m[1], method, mode: url.searchParams.get("mode"), body })
      const live = url.searchParams.get("mode") === "live"
      return json(route, {
        channel: m[1], runtime_status: "functional", probe_status: live ? "ready" : "partial", agent_connected: true, enabled: true, configured: true,
        missing_fields: [], check_mode: live ? "live" : "sandbox", latency_ms: live ? 212 : 1,
        checks: [
          { id: "config", status: "pass", message: "Required configuration is present." },
          ...(live ? [{ id: "auth", status: "pass", message: "The provider accepted the credential. No message was sent." }] : []),
        ],
        send_check: { status: "skipped", mode: "sandbox", message: "No message was sent.", latency_ms: 0 },
        next_steps: ["The live adapter is connected and only accepts sender IDs listed in allow_from."], setup_checklist: [], checked_at: new Date().toISOString(),
      })
    }
    if (p === "/api/config" && method === "PATCH") {
      state.channelPuts.push(JSON.parse(req.postData() || "{}"))
      return json(route, { status: "ok" })
    }
    if (p === "/api/config") return json(route, { channel_list: {}, agent: {} })
    if (p === "/api/sessions") return json(route, [])
    if (/^\/api\/sessions\/[^/]+$/.test(p) && method === "GET") return json(route, { id: "miki-main-chat", messages: state.sessionMessages, summary: "", created: "2026-10-29T09:00:00Z", updated: "2026-10-29T09:00:09Z" })
    if (/^\/api\/sessions\/[^/]+\/messages\/[^/]+$/.test(p) && method === "DELETE") return json(route, { status: "ok" })
    if (p === "/api/models/fetch") return json(route, { total: 5, models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini", "gpt-5.4"].map((id) => ({ id, owned_by: "openai" })) })
    if (p === "/api/models" && method === "POST") {
      const body = JSON.parse(req.postData() || "{}")
      state.modelPosts.push(body)
      if (state.failModelIds.includes(body.model)) return json(route, { error: "Provider rejected this model identifier." }, 400)
      state.models.push({ index: state.models.length, model_name: body.model_name, model: body.model, provider: body.provider, api_key: "", api_key_set: true, enabled: true, available: true, status: "available", is_default: false, is_virtual: false })
      return json(route, { status: "ok", index: state.models.length - 1 })
    }
    if (p === "/api/models") return json(route, { models: state.models, total: state.models.length, default_model: "", provider_options: [{ id: "openai", display_name: "OpenAI", default_api_base: "https://api.openai.com/v1", empty_api_key_allowed: false, create_allowed: true, default_model_allowed: true, supports_fetch: true, common_models: ["gpt-4o"] }] })
    state.unhandled.add(`${method} ${p}`)
    return json(route, {})
  })
}

export async function setTheme(page, theme) {
  await page.addInitScript((value) => {
    try { localStorage.setItem("theme", value); localStorage.setItem("miki-theme", value); localStorage.setItem("vite-ui-theme", value); localStorage.setItem("Miki:chat-assistant-detail-visibility", "all") } catch {}
  }, theme)
  await page.emulateMedia({ colorScheme: theme })
}
