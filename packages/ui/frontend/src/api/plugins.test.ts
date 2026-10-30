import { afterEach, describe, expect, it, vi } from "vitest"

import { launcherFetch } from "./http"
import { getPluginHealth, getPluginManifests, getTrustedPluginMarketplace, installTrustedPluginPackage } from "./plugins"

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

  it("surfaces a structured API error envelope", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "Probe is unavailable" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    await expect(getPluginManifests()).rejects.toThrow("Probe is unavailable")
  })

  it("preserves response error details from non-2xx responses", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "Credentials are missing" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    )
    await expect(getPluginHealth()).rejects.toThrow("Credentials are missing")
  })

  it("returns only trusted marketplace metadata from the registry API", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(new Response(JSON.stringify({ packages: [{ id: "trusted.echo", manifest: { id: "trusted.echo", displayName: "Trusted Echo", version: "1.0.0", apiVersion: "1.0", capabilities: [], runtimeStatus: "metadata_only" }, description: "A signed fixture", digest: "a".repeat(64), installed: false, trusted: true }], total: 1, source: "trusted_local_registry" }), { status: 200 }))
    const result = await getTrustedPluginMarketplace()
    expect(result.packages[0]).toMatchObject({ id: "trusted.echo", trusted: true, installed: false })
  })

  it("installs a trusted registry package by its validated id", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(new Response(JSON.stringify({ plugin: { id: "trusted.echo" } }), { status: 201 }))
    await expect(installTrustedPluginPackage("trusted.echo")).resolves.toMatchObject({ id: "trusted.echo" })
    expect(launcherFetch).toHaveBeenCalledWith("/api/plugins/install", expect.objectContaining({ method: "POST", body: JSON.stringify({ registry_id: "trusted.echo" }) }))
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
