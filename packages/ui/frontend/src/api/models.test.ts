import { beforeEach, describe, expect, it, vi } from "vitest"

import { setDefaultModel } from "./models"
import { launcherFetch } from "./http"

vi.mock("./http", async () => {
  const actual = await vi.importActual<typeof import("./http")>("./http")
  return { ...actual, launcherFetch: vi.fn() }
})
vi.mock("@/store/gateway", () => ({ refreshGatewayState: vi.fn(async () => undefined) }))

const okResponse = () =>
  new Response(JSON.stringify({ status: "ok", model_config_version: 3, active_runs: 1 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

describe("setDefaultModel", () => {
  beforeEach(() => vi.clearAllMocks())

  it("selects a model by its stable row index and sends the ordering fields", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(okResponse())

    const response = await setDefaultModel(7, { clientId: "chat-window-1", sequence: 4 })

    expect(response.status).toBe("ok")
    const [path, init] = vi.mocked(launcherFetch).mock.calls[0]
    expect(path).toBe("/api/models/default")
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      model_index: 7,
      client_id: "chat-window-1",
      request_sequence: 4,
    })
  })

  it("still works without ordering fields and sends a model name", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(okResponse())

    await setDefaultModel("gpt-example")

    const [, init] = vi.mocked(launcherFetch).mock.calls[0]
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ model_name: "gpt-example" })
  })
})
