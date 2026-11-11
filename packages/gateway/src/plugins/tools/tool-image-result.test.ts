import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  browserScreenshotToolResult,
  computerScreenshotToolResult,
  MAX_TOOL_SCREENSHOT_BYTES,
} from "./tool-image-result.js"

// A valid 1x1 PNG. The helper intentionally validates PNG structure before forwarding bytes.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5sAAAAASUVORK5CYII=",
  "base64",
)

function computerRaw(screenshot: string): string {
  return JSON.stringify({
    ok: true,
    action: "screenshot",
    data: { screenshot, width: 1, height: 1, format: "png" },
    message: "Captured desktop screenshot.",
  })
}

describe("tool screenshot image delivery", () => {
  it("turns a ComputerAgent PNG into a data URL without leaking base64 in tool text", () => {
    const result = computerScreenshotToolResult(computerRaw(ONE_PIXEL_PNG.toString("base64")))
    expect(typeof result).toBe("object")
    if (typeof result === "string") throw new Error(result)
    expect(result.kind).toBe("engine_tool_result")
    expect(result.imageUrls).toEqual([`data:image/png;base64,${ONE_PIXEL_PNG.toString("base64")}`])
    expect(result.content).toContain("available_to_agent_engine")
    expect(result.content).not.toContain(ONE_PIXEL_PNG.toString("base64"))
  })

  it("omits invalid PNG bytes and never returns the screenshot base64 as text", () => {
    const invalid = Buffer.from("not a png").toString("base64")
    const result = computerScreenshotToolResult(computerRaw(invalid))
    expect(typeof result).toBe("string")
    expect(String(result)).toContain("omitted_invalid_png")
    expect(String(result)).not.toContain(invalid)
  })

  it("rejects oversized base64 before allocating a decoded image buffer", () => {
    const oversized = "A".repeat(Math.ceil(MAX_TOOL_SCREENSHOT_BYTES / 3) * 4 + 8)
    const result = computerScreenshotToolResult(computerRaw(oversized))
    expect(typeof result).toBe("string")
    expect(String(result)).toContain("omitted_invalid_or_oversized_base64")
    expect(String(result)).not.toContain(oversized)
  })

  it("rejects decoded screenshots just above the byte limit with truthful metadata", () => {
    const justTooLarge = Buffer.alloc(MAX_TOOL_SCREENSHOT_BYTES + 1).toString("base64")
    const result = computerScreenshotToolResult(computerRaw(justTooLarge))
    expect(typeof result).toBe("string")
    expect(String(result)).toContain("omitted_size_limit")
    expect(String(result)).not.toContain(justTooLarge)
  })

  it("attaches browser screenshots only from the approved screenshot directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-browser-shot-"))
    try {
      const screenshots = path.join(root, "screenshots")
      fs.mkdirSync(screenshots, { recursive: true })
      const inside = path.join(screenshots, "inside.png")
      fs.writeFileSync(inside, ONE_PIXEL_PNG)

      const allowed = browserScreenshotToolResult(`Screenshot saved to: ${inside}`, root)
      expect(typeof allowed).toBe("object")
      if (typeof allowed === "string") throw new Error(allowed)
      expect(allowed.imageUrls).toHaveLength(1)

      const outside = path.join(root, "outside.png")
      fs.writeFileSync(outside, ONE_PIXEL_PNG)
      const rejected = browserScreenshotToolResult(`Screenshot saved to: ${outside}`, root)
      expect(typeof rejected).toBe("string")
      expect(String(rejected)).toContain("outside the approved screenshot directory")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("does not expose local filesystem paths when a browser screenshot cannot be read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-browser-shot-missing-"))
    try {
      fs.mkdirSync(path.join(root, "screenshots"), { recursive: true })
      const missing = path.join(root, "screenshots", "missing.png")
      const result = browserScreenshotToolResult(`Screenshot saved to: ${missing}`, root)
      expect(typeof result).toBe("string")
      expect(String(result)).not.toContain(root)
      expect(String(result)).toContain("could not be safely accessed")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
