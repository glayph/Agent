import fs from "node:fs"
import path from "node:path"
import type { EngineToolResult } from "@miki/core/engine"

export const MAX_TOOL_SCREENSHOT_BYTES = 4 * 1024 * 1024
const MAX_SCREENSHOT_BASE64_CHARS = Math.ceil(MAX_TOOL_SCREENSHOT_BYTES / 3) * 4 + 4
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IHDR = Buffer.from("IHDR", "ascii")

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function hasPngHeader(bytes: Buffer): boolean {
  if (bytes.byteLength < 33 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false
  if (bytes.readUInt32BE(8) !== 13 || !bytes.subarray(12, 16).equals(PNG_IHDR)) return false
  return bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
}

function decodeCanonicalBase64Image(value: string): Buffer | undefined {
  if (!value || value.length > MAX_SCREENSHOT_BASE64_CHARS || value.length % 4 !== 0) return undefined
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined
  const bytes = Buffer.from(value, "base64")
  if (bytes.byteLength === 0 || bytes.toString("base64") !== value) return undefined
  return bytes
}

export function toPngToolResult(content: string, bytes: Buffer): EngineToolResult | string {
  if (bytes.byteLength > MAX_TOOL_SCREENSHOT_BYTES) {
    return `${content}\nScreenshot was captured but not attached because it exceeds the ${MAX_TOOL_SCREENSHOT_BYTES}-byte model input limit.`
  }
  if (!hasPngHeader(bytes)) {
    return `${content}\nScreenshot was captured but not attached because it does not contain a valid PNG header.`
  }
  return {
    kind: "engine_tool_result",
    content,
    imageUrls: [`data:image/png;base64,${bytes.toString("base64")}`],
  }
}

/** Convert the ComputerAgent JSON screenshot into a bounded image attachment without leaking base64 into tool text. */
export function computerScreenshotToolResult(raw: string): EngineToolResult | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return "Computer screenshot returned an unrecognized response; image data was not forwarded."
  }
  if (!isRecord(parsed)) return "Computer screenshot returned an invalid response; image data was not forwarded."

  const data = isRecord(parsed.data) ? parsed.data : undefined
  if (!data || typeof data.screenshot !== "string") {
    return JSON.stringify(parsed)
  }

  const { screenshot: base64, ...safeData } = data
  const safePayload = { ...parsed, data: safeData }
  if (parsed.ok !== true) {
    return JSON.stringify({ ...safePayload, imageAttachment: "omitted_failed_capture" })
  }
  const bytes = decodeCanonicalBase64Image(base64)
  if (!bytes) {
    return JSON.stringify({ ...safePayload, imageAttachment: "omitted_invalid_or_oversized_base64" })
  }

  if (bytes.byteLength > MAX_TOOL_SCREENSHOT_BYTES) {
    return JSON.stringify({ ...safePayload, imageAttachment: "omitted_size_limit" })
  }
  if (!hasPngHeader(bytes)) {
    return JSON.stringify({ ...safePayload, imageAttachment: "omitted_invalid_png" })
  }
  const content = JSON.stringify({ ...safePayload, imageAttachment: "available_to_agent_engine" })
  return {
    kind: "engine_tool_result",
    content,
    imageUrls: [`data:image/png;base64,${bytes.toString("base64")}`],
  }
}

/** Read only a BrowserTool screenshot under the dedicated screenshot root. */
export function browserScreenshotToolResult(raw: string, dataRoot: string): EngineToolResult | string {
  const prefix = "Screenshot saved to: "
  if (!raw.startsWith(prefix)) return raw

  try {
    const screenshotRoot = fs.realpathSync(path.resolve(dataRoot, "screenshots"))
    const requested = path.resolve(raw.slice(prefix.length).trim())
    const realPath = fs.realpathSync(requested)
    const relative = path.relative(screenshotRoot, realPath)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return "Screenshot was saved outside the approved screenshot directory and was not attached."
    }

    const stat = fs.statSync(realPath)
    if (!stat.isFile()) return "Screenshot path is not a regular file and was not attached."
    if (stat.size > MAX_TOOL_SCREENSHOT_BYTES) {
      return `Browser screenshot was captured (${stat.size} bytes) but not attached because it exceeds the ${MAX_TOOL_SCREENSHOT_BYTES}-byte model input limit.`
    }
    return toPngToolResult("Browser screenshot captured and made available for visual inspection.", fs.readFileSync(realPath))
  } catch {
    // Do not expose absolute filesystem paths or OS error details to the model/user.
    return "Browser screenshot could not be safely accessed inside the approved screenshot directory; it was not attached."
  }
}
