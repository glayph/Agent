import fs from "node:fs"
import path from "node:path"

/**
 * Chat "proof" attachments.
 *
 * The chat UI can already render image/audio/video/file attachments on assistant
 * messages, but the gateway only ever sent text. This module turns the *outputs of
 * tool calls* (browser screenshots, files the agent wrote) into attachment payloads
 * the UI understands, and resolves them back to disk for `/api/chat-media`.
 */

export type ChatAttachmentType = "image" | "audio" | "video" | "file"

export interface ChatAttachmentPayload {
  type: ChatAttachmentType
  url: string
  filename: string
  content_type: string
}

export interface AttachmentContext {
  /** Agent workspace; relative tool paths resolve against it. */
  workspaceRoot: string
  /** Gateway data dir; browser screenshots live in `<dataRoot>/screenshots`. */
  dataRoot?: string
}

export interface ToolCallLike {
  name: string
  arguments?: string
  status: string
  resultPreview?: string
}

export const MEDIA_ROUTE = "/api/chat-media"
export const MAX_ATTACHMENTS_PER_RUN = 8
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const KNOWN_TYPES: Record<string, [ChatAttachmentType, string]> = {
  ".png": ["image", "image/png"],
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".gif": ["image", "image/gif"],
  ".webp": ["image", "image/webp"],
  ".bmp": ["image", "image/bmp"],
  ".ico": ["image", "image/x-icon"],
  ".avif": ["image", "image/avif"],
  ".tif": ["image", "image/tiff"],
  ".tiff": ["image", "image/tiff"],
  ".svg": ["image", "image/svg+xml"],
  ".heic": ["image", "image/heic"],
  ".heif": ["image", "image/heif"],
  ".mp3": ["audio", "audio/mpeg"],
  ".wav": ["audio", "audio/wav"],
  ".ogg": ["audio", "audio/ogg"],
  ".flac": ["audio", "audio/flac"],
  ".m4a": ["audio", "audio/mp4"],
  ".aac": ["audio", "audio/aac"],
  ".aif": ["audio", "audio/aiff"],
  ".aiff": ["audio", "audio/aiff"],
  ".oga": ["audio", "audio/ogg"],
  ".opus": ["audio", "audio/opus"],
  ".wma": ["audio", "audio/x-ms-wma"],
  ".mp4": ["video", "video/mp4"],
  ".m4v": ["video", "video/mp4"],
  ".3gp": ["video", "video/3gpp"],
  ".webm": ["video", "video/webm"],
  ".ogv": ["video", "video/ogg"],
  ".mov": ["video", "video/quicktime"],
  ".wmv": ["video", "video/x-ms-wmv"],
  ".mkv": ["video", "video/x-matroska"],
  ".avi": ["video", "video/x-msvideo"],
  ".mpeg": ["video", "video/mpeg"],
  ".mpg": ["video", "video/mpeg"],
  ".pdf": ["file", "application/pdf"],
  ".doc": ["file", "application/msword"],
  ".docx": ["file", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xls": ["file", "application/vnd.ms-excel"],
  ".xlsx": ["file", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".ppt": ["file", "application/vnd.ms-powerpoint"],
  ".pptx": ["file", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".rtf": ["file", "application/rtf"],
  ".odt": ["file", "application/vnd.oasis.opendocument.text"],
  ".ods": ["file", "application/vnd.oasis.opendocument.spreadsheet"],
  ".odp": ["file", "application/vnd.oasis.opendocument.presentation"],
  ".7z": ["file", "application/x-7z-compressed"],
  ".zip": ["file", "application/zip"],
  ".md": ["file", "text/markdown"],
  ".txt": ["file", "text/plain"],
  ".csv": ["file", "text/csv"],
  ".json": ["file", "application/json"],
  ".xml": ["file", "application/xml"],
  ".yaml": ["file", "application/yaml"],
  ".yml": ["file", "application/yaml"],
  ".toml": ["file", "application/toml"],
  ".ini": ["file", "text/plain"],
  ".log": ["file", "text/plain"],
  ".html": ["file", "text/html"],
  ".css": ["file", "text/css"],
  ".js": ["file", "text/javascript"],
  ".jsx": ["file", "text/plain"],
  ".ts": ["file", "text/plain"],
  ".tsx": ["file", "text/plain"],
  ".py": ["file", "text/plain"],
  ".sh": ["file", "text/plain"],
  ".go": ["file", "text/plain"],
  ".rs": ["file", "text/plain"],
  ".java": ["file", "text/plain"],
  ".c": ["file", "text/plain"],
  ".cpp": ["file", "text/plain"],
  ".h": ["file", "text/plain"],
}

/** Never exposed through the media route, whatever the root. */
const BLOCKED_BASENAME = /^(\.env.*|.*\.sqlite.*|.*\.db|.*\.pem|.*\.key|id_rsa.*|.*secret.*|.*credential.*)$/i

const isBlockedPath = (file: string) => {
  const parts = file.replaceAll("\\", "/").split("/").filter(Boolean)
  const base = parts[parts.length - 1] || ""
  return parts.includes(".git") || BLOCKED_BASENAME.test(base)
}

export function describeFile(file: string): { type: ChatAttachmentType; contentType: string } | null {
  const known = KNOWN_TYPES[path.extname(file).toLowerCase()]
  return known ? { type: known[0], contentType: known[1] } : null
}

function mediaRoots(ctx: AttachmentContext): string[] {
  const roots = [ctx.workspaceRoot]
  if (ctx.dataRoot) roots.push(path.join(ctx.dataRoot, "screenshots"))
  return roots.map((root) => {
    try { return fs.realpathSync(root) } catch { return path.resolve(root) }
  })
}

const isInside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Resolve a requested path to a real file that is allowed to be served, or null.
 * Allowed = inside the workspace or the screenshots dir, a known extension,
 * not a secret/db file, and at most MAX_ATTACHMENT_BYTES.
 */
export function resolveMediaPath(raw: string, ctx: AttachmentContext): string | null {
  if (!raw || raw.includes("\0")) return null
  let real: string
  try {
    const candidate = path.isAbsolute(raw) ? raw : path.resolve(ctx.workspaceRoot, raw)
    real = fs.realpathSync(candidate)
  } catch {
    return null
  }
  if (!mediaRoots(ctx).some((root) => isInside(root, real))) return null
  if (isBlockedPath(real)) return null
  if (!describeFile(real)) return null
  try {
    const stat = fs.statSync(real)
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) return null
  } catch {
    return null
  }
  return real
}

export function toAttachment(file: string): ChatAttachmentPayload | null {
  const info = describeFile(file)
  if (!info) return null
  return {
    type: info.type,
    url: `${MEDIA_ROUTE}?path=${encodeURIComponent(file)}`,
    filename: path.basename(file),
    content_type: info.contentType,
  }
}

function requestedPathFromMediaUrl(rawUrl: string): string | null {
  if (!rawUrl || rawUrl.startsWith("data:")) return null
  try {
    const url = new URL(rawUrl, "http://miki.local")
    if (url.pathname !== MEDIA_ROUTE) return null
    return url.searchParams.get("path")
  } catch {
    return null
  }
}

/** Resolves an existing chat-media URL to an allowed file in the workspace. */
export function workspaceRelativePathFromMediaUrl(
  rawUrl: string,
  ctx: AttachmentContext,
): string | null {
  const requested = requestedPathFromMediaUrl(rawUrl)
  if (!requested) return null
  const file = resolveMediaPath(requested, ctx)
  if (!file) return null
  const relative = path.relative(ctx.workspaceRoot, file)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join("/")
}

/** Makes a supported uploaded image available to image-capable model providers. */
export function imageDataUrlFromMediaUrl(
  rawUrl: string,
  ctx: AttachmentContext,
): string | null {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(rawUrl)) return rawUrl
  const requested = requestedPathFromMediaUrl(rawUrl)
  if (!requested) return null
  const file = resolveMediaPath(requested, ctx)
  if (!file) return null
  const info = describeFile(file)
  // Use broadly supported vision formats for direct model input. Other image types
  // remain attached by workspace path so one unsupported MIME cannot fail the turn.
  if (!info || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(info.contentType)) return null
  try {
    return `data:${info.contentType};base64,${fs.readFileSync(file).toString("base64")}`
  } catch {
    return null
  }
}

function safeJson(text: string | undefined): Record<string, unknown> {
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** File paths a *succeeded* tool call produced and that are worth showing as proof. */
export function candidatePathsFromToolCall(call: ToolCallLike): string[] {
  if (call.status !== "succeeded") return []
  const paths: string[] = []
  if (call.name === "browser_screenshot") {
    const match = /Screenshot saved to:\s*(.+?\.png)/i.exec(call.resultPreview || "")
    if (match?.[1]) paths.push(match[1].trim())
  } else if (call.name === "file_write") {
    const args = safeJson(call.arguments)
    if (typeof args.path === "string" && args.path.trim()) paths.push(args.path.trim())
  }
  return paths
}

/**
 * Collects attachments across one run, de-duplicated by real path and capped.
 * Feed it every `tool.call` event; read `list()` when the final answer is sent.
 */
export function createAttachmentCollector(getContext: () => AttachmentContext) {
  const byPath = new Map<string, ChatAttachmentPayload>()
  return {
    observe(call: ToolCallLike): void {
      if (byPath.size >= MAX_ATTACHMENTS_PER_RUN) return
      for (const raw of candidatePathsFromToolCall(call)) {
        const real = resolveMediaPath(raw, getContext())
        if (!real || byPath.has(real)) continue
        const attachment = toAttachment(real)
        if (attachment) byPath.set(real, attachment)
        if (byPath.size >= MAX_ATTACHMENTS_PER_RUN) return
      }
    },
    list(): ChatAttachmentPayload[] {
      return Array.from(byPath.values())
    },
  }
}
