import type { AddressInfo } from "node:net"

import express from "express"

import { createDashboardExtendedRouter, type DashboardExtendedDeps } from "./dashboard-extended.js"

type Json = Record<string, any>

async function withServer(
  config: Record<string, unknown>,
  run: (call: (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; text: string; json: Json }>) => Promise<void>,
  runtime: DashboardExtendedDeps["channelRuntimeStatus"] = () => ({ runtime_live: false, connected: false, enabled: true, configured: false }),
  fetchImpl?: typeof fetch,
) {
  // The probe routes never touch the database; a permissive stub lets the router initialise.
  const dbStub = new Proxy({}, { get: () => () => ({ run: () => ({}), get: () => undefined, all: () => [] }) })
  const deps = {
    db: dbStub,
    dataRoot: "/tmp/miki-probe-test-data",
    configDir: "/tmp/miki-probe-test-config",
    projectRoot: "/tmp/miki-probe-test-root",
    workspaceRoot: "/tmp/miki-probe-test-workspace",
    getAppConfig: () => config,
    requireAuth: ((_req, _res, next) => next()) as DashboardExtendedDeps["requireAuth"],
    now: () => "2026-10-28T00:00:00.000Z",
    channelRuntimeStatus: runtime,
    fetchImpl,
  } as unknown as DashboardExtendedDeps
  const app = express()
  app.use(express.json())
  app.use("/api", createDashboardExtendedRouter(deps))
  const server = app.listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const { port } = server.address() as AddressInfo
  try {
    await run(async (method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, text, json: text ? JSON.parse(text) : {} }
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe("channel draft probe", () => {
  it("tests unsaved draft settings without persisting them", async () => {
    const config = { channel_list: { telegram: { type: "telegram", enabled: true, allow_from: [] } } }
    const before = JSON.stringify(config)
    await withServer(config, async (call) => {
      const saved = await call("GET", "/channels/telegram/probe")
      expect(saved.status).toBe(200)
      expect(saved.json.configured).toBe(false)
      expect(saved.json.missing_fields).toContain("token")

      const draft = await call("POST", "/channels/telegram/probe", {
        config: { enabled: true, token: "draft-secret-token", allow_from: ["42"] },
      })
      expect(draft.status).toBe(200)
      expect(draft.json.configured).toBe(true)
      expect(draft.json.missing_fields).toEqual([])
    })
    expect(JSON.stringify(config)).toBe(before)
  })

  it("never echoes credential values in the response", async () => {
    await withServer({ channel_list: {} }, async (call) => {
      const draft = await call("POST", "/channels/telegram/probe", {
        config: { token: "super-secret-value-123" },
      })
      expect(draft.status).toBe(200)
      expect(draft.text).not.toContain("super-secret-value-123")
    })
  })

  it("warns about an empty allow_from on sender-gated channels", async () => {
    await withServer({ channel_list: {} }, async (call) => {
      const draft = await call("POST", "/channels/telegram/probe", {
        config: { enabled: true, token: "t", allow_from: [] },
      })
      expect(draft.json.checks.some((check: Json) => check.id === "allow_from" && check.status === "warn")).toBe(true)
    })
  })

  it("reports a disabled draft as disabled", async () => {
    await withServer({ channel_list: {} }, async (call) => {
      const draft = await call("POST", "/channels/telegram/probe", { config: { enabled: false, token: "t" } })
      expect(draft.json.probe_status).toBe("disabled")
    })
  })

  it("never reports a non-functional channel as ready", async () => {
    await withServer({ channel_list: {} }, async (call) => {
      const draft = await call("POST", "/channels/whatsapp/probe", { config: { enabled: true } })
      expect(draft.status).toBe(200)
      expect(draft.json.probe_status).not.toBe("ready")
      expect(["partial", "not_implemented", "needs_config"]).toContain(draft.json.probe_status)
    })
  })

  it("rejects unknown channels", async () => {
    await withServer({ channel_list: {} }, async (call) => {
      expect((await call("POST", "/channels/nope/probe", { config: {} })).status).toBe(404)
      expect((await call("GET", "/channels/nope/probe")).status).toBe(404)
    })
  })
})

describe("live channel authentication check", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const idle = () => ({ runtime_live: false, connected: false, enabled: true, configured: true })
  const SECRET = "live-secret-token-987"

  function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fn = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      return handler(url, init ?? {})
    }) as unknown as typeof fetch
    return { fn, calls }
  }

  it("verifies a Telegram token with getMe only when mode=live", async () => {
    const { fn, calls } = mockFetch(() => json({ ok: true, result: { id: 1 } }))
    await withServer({ channel_list: {} }, async (call) => {
      const quick = await call("POST", "/channels/telegram/probe", { config: { enabled: true, token: SECRET, allow_from: ["1"] } })
      expect(quick.status).toBe(200)
      expect(calls).toHaveLength(0)
      expect(quick.json.check_mode).not.toBe("live")

      const live = await call("POST", "/channels/telegram/probe?mode=live", { config: { enabled: true, token: SECRET, allow_from: ["1"] } })
      expect(live.status).toBe(200)
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(`https://api.telegram.org/bot${SECRET}/getMe`)
      expect(calls[0].init.method).toBe("GET")
      expect(live.json.check_mode).toBe("live")
      expect(live.json.checks.find((check: Json) => check.id === "auth").status).toBe("pass")
      expect(live.json.send_check.status).toBe("skipped")
    }, idle, fn)
  })

  it("never runs the provider check from GET", async () => {
    const { fn, calls } = mockFetch(() => json({ ok: true }))
    const config = { channel_list: { telegram: { type: "telegram", enabled: true, token: SECRET } } }
    await withServer(config, async (call) => {
      const res = await call("GET", "/channels/telegram/probe?mode=live")
      expect(res.status).toBe(200)
      expect(calls).toHaveLength(0)
      expect(res.json.checks.some((check: Json) => check.id === "auth")).toBe(false)
    }, idle, fn)
  })

  it("uses Discord users/@me and Slack auth.test with the bot token", async () => {
    const { fn, calls } = mockFetch((url) => (url.includes("slack.com") ? json({ ok: true, team: "t" }) : json({ id: "123", username: "bot" })))
    await withServer({ channel_list: {} }, async (call) => {
      const discord = await call("POST", "/channels/discord/probe?mode=live", { config: { enabled: true, token: SECRET, allow_from: ["1"] } })
      expect(discord.json.checks.find((check: Json) => check.id === "auth").status).toBe("pass")
      const slack = await call("POST", "/channels/slack/probe?mode=live", { config: { enabled: true, bot_token: SECRET, app_token: "xapp-1", allow_from: ["1"] } })
      expect(slack.json.checks.find((check: Json) => check.id === "auth").status).toBe("pass")
    }, idle, fn)
    expect(calls.map((entry) => entry.url)).toEqual(["https://discord.com/api/v10/users/@me", "https://slack.com/api/auth.test"])
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bot ${SECRET}`)
    expect(calls[1].init.method).toBe("POST")
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`)
  })

  it("reports a rejected credential without echoing it", async () => {
    const { fn } = mockFetch(() => json({ ok: false, description: `Unauthorized ${SECRET}` }, 401))
    await withServer({ channel_list: {} }, async (call) => {
      const res = await call("POST", "/channels/telegram/probe?mode=live", { config: { enabled: true, token: SECRET, allow_from: ["1"] } })
      expect(res.status).toBe(200)
      expect(res.json.probe_status).toBe("auth_failed")
      expect(res.json.failure_code).toBe("auth_rejected")
      expect(res.json.checks.find((check: Json) => check.id === "auth").status).toBe("fail")
      expect(res.text).not.toContain(SECRET)
    }, idle, fn)
  })

  it("treats Slack ok:false as rejected", async () => {
    const { fn } = mockFetch(() => json({ ok: false, error: "invalid_auth" }))
    await withServer({ channel_list: {} }, async (call) => {
      const res = await call("POST", "/channels/slack/probe?mode=live", { config: { enabled: true, bot_token: SECRET, app_token: "xapp-1", allow_from: ["1"] } })
      expect(res.json.failure_code).toBe("auth_rejected")
      expect(res.text).not.toContain(SECRET)
    }, idle, fn)
  })

  it("does not leak the credential through network errors", async () => {
    const { fn } = mockFetch((url) => {
      throw new Error(`connect ECONNREFUSED ${url}`)
    })
    await withServer({ channel_list: {} }, async (call) => {
      const res = await call("POST", "/channels/telegram/probe?mode=live", { config: { enabled: true, token: SECRET, allow_from: ["1"] } })
      expect(res.json.failure_code).toBe("auth_network_error")
      expect(res.json.probe_status).toBe("runtime_error")
      expect(res.text).not.toContain(SECRET)
    }, idle, fn)
  })

  it("aborts after the 8 second timeout window", async () => {
    let seenSignal: AbortSignal | null | undefined
    const { fn } = mockFetch((_url, init) => {
      seenSignal = init.signal
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
    })
    await withServer({ channel_list: {} }, async (call) => {
      const res = await call("POST", "/channels/telegram/probe?mode=live", { config: { enabled: true, token: SECRET, allow_from: ["1"] } })
      expect(res.json.failure_code).toBe("auth_timeout")
      expect(res.json.checks.find((check: Json) => check.id === "auth").message).toContain("8 seconds")
    }, idle, fn)
    expect(seenSignal).toBeInstanceOf(AbortSignal)
  })

  it("skips the provider call without a credential, when disabled, and for other channels", async () => {
    const { fn, calls } = mockFetch(() => json({ ok: true }))
    await withServer({ channel_list: {} }, async (call) => {
      await call("POST", "/channels/telegram/probe?mode=live", { config: { enabled: true, allow_from: ["1"] } })
      await call("POST", "/channels/telegram/probe?mode=live", { config: { enabled: false, token: SECRET } })
      const feishu = await call("POST", "/channels/feishu/probe?mode=live", { config: { enabled: true, app_id: "a", app_secret: "b" } })
      expect(feishu.json.check_mode).toBe("sandbox")
    }, idle, fn)
    expect(calls).toHaveLength(0)
  })

  it("does not persist the draft credential", async () => {
    const config = { channel_list: { telegram: { type: "telegram", enabled: true } } }
    const before = JSON.stringify(config)
    const { fn } = mockFetch(() => json({ ok: true }))
    await withServer(config, async (call) => {
      await call("POST", "/channels/telegram/probe?mode=live", { config: { enabled: true, token: SECRET, allow_from: ["1"] } })
    }, idle, fn)
    expect(JSON.stringify(config)).toBe(before)
  })
})
