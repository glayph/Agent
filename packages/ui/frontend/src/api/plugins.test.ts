import { afterEach, describe, expect, it, vi } from "vitest"

import { launcherFetch } from "./http"
import { getPluginHealth, getPluginManifests } from "./plugins"

vi.mock("./http", () => ({
  launcherFetch: vi.fn(),
}))

describe("Plugin API response compatibility", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("unwraps the built-in manifest success envelope", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            manifests: [
              {
                id: "provider.gemini",
                displayName: "Google Gemini",
                version: "1.0.0",
                apiVersion: "1.0",
                capabilities: ["ai-provider"],
                runtimeStatus: "partial",
              },
            ],
            total: 1,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    const result = await getPluginManifests()

    expect(result.total).toBe(1)
    expect(result.manifests[0]?.id).toBe("provider.gemini")
  })

  it("unwraps capability health and preserves status details", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            health: {
              "browser.playwright": {
                ok: true,
                status: "functional",
                latencyMs: 4,
              },
            },
            total: 1,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    const result = await getPluginHealth()

    expect(result.health["browser.playwright"]?.ok).toBe(true)
    expect(result.health["browser.playwright"]?.latencyMs).toBe(4)
  })
})
