import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { GatewayBackendError, launcherFetch } from "./http"

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("launcherFetch HTTP client wrapper", () => {
  it("executes fetch with same-origin credentials", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", mockFetch)

    const res = await launcherFetch("/api/test")
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledWith("/api/test", {
      credentials: "same-origin",
    })
  })

  it("shows a JSON API error message without consuming the response body", async () => {
    const response = new Response(JSON.stringify({
      error: "Provider is offline",
      code: "provider_error",
      request_id: "req-1",
    }), {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "application/json" },
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response))

    const result = await launcherFetch("/api/model", { showErrorToast: true })

    expect(toast.error).toHaveBeenCalledWith("Provider is offline")
    await expect(result.json()).resolves.toMatchObject({ code: "provider_error" })
  })

  it("does not describe a backend compatibility error as a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { "x-miki-backend-role": "compatibility-stub" },
    })))

    await expect(launcherFetch("/api/tools", { showErrorToast: true })).rejects.toBeInstanceOf(GatewayBackendError)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("compatibility stub"))
  })

  it("shows a generic network message only when the fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")))

    await expect(launcherFetch("/api/test", { showErrorToast: true })).rejects.toThrow("fetch failed")
    expect(toast.error).toHaveBeenCalledWith("Network error: Please check your connection.")
  })
})
