import { afterEach, describe, expect, it, vi } from "vitest"

import { launcherFetch } from "./http"
import { getSkills } from "./skills"

vi.mock("./http", () => ({
  launcherFetch: vi.fn(),
}))

describe("Skills API response compatibility", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("unwraps the backend success envelope", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            skills: [
              {
                name: "bundled/example",
                path: "/skills/example",
                source: "builtin",
                description: "Example skill",
                origin_kind: "builtin",
              },
            ],
            total: 1,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    const result = await getSkills()

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]?.name).toBe("bundled/example")
    expect(result.total).toBe(1)
  })

  it("preserves the direct compatibility payload", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          skills: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    await expect(getSkills()).resolves.toEqual({ skills: [] })
  })
})
