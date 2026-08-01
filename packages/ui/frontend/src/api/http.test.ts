import { describe, expect, it, vi } from "vitest"

import { launcherFetch } from "./http"

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}))

describe("launcherFetch HTTP client wrapper", () => {
  it("executes fetch with same-origin credentials", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
    })
    globalThis.fetch = mockFetch

    const res = await launcherFetch("/api/test")
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledWith("/api/test", {
      credentials: "same-origin",
    })
  })
})
