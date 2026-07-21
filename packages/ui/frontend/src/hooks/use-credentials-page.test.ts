import { describe, expect, it, vi } from "vitest"

import { loginOAuth, logoutOAuth, pollOAuthFlow } from "@/api/oauth"
import {
  getOAuthPollIntervalMs,
  getProviderLabel,
} from "@/hooks/use-credentials-page"

const { launcherFetch } = vi.hoisted(() => ({
  launcherFetch: vi.fn(),
}))

vi.mock("@/api/http", () => ({
  launcherFetch,
}))

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

describe("credentials flow", () => {
  it("labels supported providers and clamps OAuth device polling intervals", () => {
    expect(getProviderLabel("openai")).toBe("OpenAI")
    expect(getProviderLabel("anthropic")).toBe("Anthropic")
    expect(getProviderLabel("google-antigravity")).toBe("Google Antigravity")
    expect(getProviderLabel("")).toBe("")

    expect(getOAuthPollIntervalMs(undefined)).toBe(5000)
    expect(getOAuthPollIntervalMs(0)).toBe(1000)
    expect(getOAuthPollIntervalMs(7)).toBe(7000)
  })

  it("submits token, browser, poll, and logout requests to the launcher API", async () => {
    launcherFetch
      .mockResolvedValueOnce(
        jsonResponse({
          status: "pending",
          provider: "openai",
          method: "token",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          flow_id: "flow-1",
          provider: "openai",
          method: "device_code",
          status: "success",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          provider: "openai",
        }),
      )

    await expect(
      loginOAuth({ provider: "openai", method: "token", token: "sk-test" }),
    ).resolves.toMatchObject({ provider: "openai", method: "token" })
    await expect(pollOAuthFlow("flow-1")).resolves.toMatchObject({
      flow_id: "flow-1",
      status: "success",
    })
    await expect(logoutOAuth("openai")).resolves.toMatchObject({
      provider: "openai",
    })

    expect(launcherFetch).toHaveBeenNthCalledWith(
      1,
      "/api/oauth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          provider: "openai",
          method: "token",
          token: "sk-test",
        }),
      }),
    )
    expect(launcherFetch).toHaveBeenNthCalledWith(
      2,
      "/api/oauth/flows/flow-1/poll",
      expect.objectContaining({ method: "POST" }),
    )
    expect(launcherFetch).toHaveBeenNthCalledWith(
      3,
      "/api/oauth/logout",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ provider: "openai" }),
      }),
    )
  })
})
