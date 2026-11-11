import { createHash } from "node:crypto"
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
/** Workspace folder that holds copies of files the agent sent from outside the served roots. */
export const OUTBOX_DIR = ".miki-chat-outbox"
/** Cap on automatically collected "proof" files per run; explicit chat_send_file deliveries are not counted. */
export const MAX_ATTACHMENTS_PER_RUN = 8
/** Largest file the chat media route will serve. Override with MIKI_CHAT_MEDIA_MAX_MB (default 512 MB). */
const configuredMediaMb = Number(process.env.MIKI_CHAT_MEDIA_MAX_MB)
export const MAX_ATTACHMENT_BYTES =
  (Number.isFinite(configuredMediaMb) && configuredMediaMb > 0 ? configuredMediaMb : 512) * 1024 * 1024
export const SEND_FILE_TOOL = "chat_send_file"
const GENERIC_FILE: { type: ChatAttachmentType; contentType: string } = { type: "file", contentType: "application/octet-stream" }

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
  ".jpe": ["image", "image/jpeg"],
  ".jfif": ["image", "image/jpeg"],
  ".mid": ["audio", "audio/midi"],
  ".midi": ["audio", "audio/midi"],
  ".weba": ["audio", "audio/webm"],
  ".flv": ["video", "video/x-flv"],
  ".gz": ["file", "application/gzip"],
  ".tgz": ["file", "application/gzip"],
  ".tar": ["file", "application/x-tar"],
  ".bz2": ["file", "application/x-bzip2"],
  ".xz": ["file", "application/x-xz"],
  ".rar": ["file", "application/vnd.rar"],
  ".epub": ["file", "application/epub+zip"],
  ".tsv": ["file", "text/tab-separated-values"],
  ".jsonl": ["file", "application/x-ndjson"],
  ".ipynb": ["file", "application/x-ipynb+json"],
  ".sql": ["file", "text/plain"],
  ".rb": ["file", "text/plain"],
  ".php": ["file", "text/plain"],
  ".kt": ["file", "text/plain"],
  ".swift": ["file", "text/plain"],
}

/** Source, markup and config formats that file_write must not auto-attach as "proof"; send them with chat_send_file. */
const CODE_LIKE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".rb", ".php", ".kt", ".swift", ".sql",
  ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".xml", ".log", ".html", ".css",
])

/** Never exposed through the media route, whatever the root. */
const BLOCKED_BASENAME = /^(\.env.*|.*\.sqlite.*|.*\.db|.*\.pem|.*\.key|id_rsa.*|.*secret.*|.*credential.*)$/i

const isBlockedPath = (file: string) => {
  const parts = file.replaceAll("\\", "/").split("/").filter(Boolean)
  const base = parts[parts.length - 1] || ""
  return parts.includes(".git") || BLOCKED_BASENAME.test(base)
}

export function describeFile(
  file: string,
  options: { fallback?: boolean } = {},
): { type: ChatAttachmentType; contentType: string } | null {
  const known = KNOWN_TYPES[path.extname(file).toLowerCase()]
  if (known) return { type: known[0], contentType: known[1] }
  return options.fallback ? { ...GENERIC_FILE } : null
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

const realOrResolved = (target: string) => {
  try { return fs.realpathSync(target) } catch { return path.resolve(target) }
}

/** True for files inside this workspace's outbox, the only place unknown file types may be served from. */
function isOutboxFile(file: string, ctx: AttachmentContext): boolean {
  return isInside(path.join(realOrResolved(ctx.workspaceRoot), OUTBOX_DIR), file)
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
  if (!describeFile(real, { fallback: isOutboxFile(real, ctx) })) return null
  try {
    const stat = fs.statSync(real)
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) return null
  } catch {
    return null
  }
  return real
}

export function toAttachment(file: string, options: { fallback?: boolean } = {}): ChatAttachmentPayload | null {
  const info = describeFile(file, options)
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

/** Paths a succeeded chat_send_file call delivered (single `path` or a `paths` list). */
export function sentPathsFromToolCall(call: ToolCallLike): string[] {
  if (call.name !== SEND_FILE_TOOL || call.status !== "succeeded") return []
  const args = safeJson(call.arguments)
  const paths: string[] = []
  if (typeof args.path === "string" && args.path.trim()) paths.push(args.path.trim())
  if (Array.isArray(args.paths)) {
    for (const item of args.paths) if (typeof item === "string" && item.trim()) paths.push(item.trim())
  }
  return paths
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
    // Source code and config written during a task are not deliverables; chat_send_file sends those on request.
    if (typeof args.path === "string" && args.path.trim() && !CODE_LIKE_EXTENSIONS.has(path.extname(args.path.trim()).toLowerCase())) {
      paths.push(args.path.trim())
    }
  }
  return paths
}

/**
 * Collects attachments across one run, de-duplicated by real path and capped.
 * Feed it every `tool.call` event; read `list()` when the final answer is sent.
 * Files already delivered with chat_send_file are never attached a second time.
 */
export function createAttachmentCollector(getContext: () => AttachmentContext) {
  const byPath = new Map<string, ChatAttachmentPayload>()
  const delivered = new Set<string>()
  return {
    observe(call: ToolCallLike): void {
      if (call.name === SEND_FILE_TOOL) {
        for (const raw of sentPathsFromToolCall(call)) {
          const real = resolveMediaPath(raw, getContext())
          if (!real) continue
          delivered.add(real)
          byPath.delete(real)
        }
        return
      }
      if (byPath.size >= MAX_ATTACHMENTS_PER_RUN) return
      for (const raw of candidatePathsFromToolCall(call)) {
        const real = resolveMediaPath(raw, getContext())
        if (!real || byPath.has(real) || delivered.has(real)) continue
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

// ---------------------------------------------------------------------------
// Explicit delivery (chat_send_file)
// ---------------------------------------------------------------------------

export interface StageOptions {
  /** Lets the agent send a file from anywhere on disk (when restrict_to_workspace is off). */
  allowOutsideWorkspace?: boolean
  /** Directory that relative paths resolve against; defaults to the served workspace. */
  baseDir?: string
  /** Extra roots the agent may read from; files there are copied into the outbox before serving. */
  extraAllowedRoots?: string[]
}

export interface StagedChatFile {
  attachment: ChatAttachmentPayload
  sizeBytes: number
  /** True when a copy was placed in the outbox because the original is not under a served root. */
  copied: boolean
}

const sha256File = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
  })

const safeFileName = (name: string) =>
  name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/^\.+/, "_").trim().slice(0, 160) || "file"

/**
 * Makes one file ready to be shown in chat and returns its attachment payload.
 * Files already under a served root with a known type are referenced in place; everything
 * else (other folders, unknown types) is copied once into `<workspace>/.miki-chat-outbox`.
 * Credential/secret/database/.git files are refused regardless of where they live.
 * Errors are written for the model: they say what to change so it can fix the call itself.
 */
export async function stageChatFile(raw: string, ctx: AttachmentContext, options: StageOptions = {}): Promise<StagedChatFile> {
  const input = String(raw ?? "").trim()
  if (!input || input.includes("\0")) throw new Error("A file path is required.")
  const baseDir = options.baseDir || ctx.workspaceRoot
  const candidate = path.isAbsolute(input) ? input : path.resolve(baseDir, input)
  let real: string
  try {
    real = fs.realpathSync(candidate)
  } catch {
    throw new Error(`File not found: ${input}. Check the path with workspace_list or terminal_run first.`)
  }
  const stat = fs.statSync(real)
  if (!stat.isFile()) throw new Error("Path is a directory, not a file. Create a .zip or .tar.gz archive first and send the archive.")
  if (stat.size === 0) throw new Error("The file is empty, so there is nothing to show. Finish creating it first.")
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`The file is ${(stat.size / 1048576).toFixed(1)} MB; the chat media limit is ${Math.floor(MAX_ATTACHMENT_BYTES / 1048576)} MB (MIKI_CHAT_MEDIA_MAX_MB). Compress or split it.`)
  }
  if (isBlockedPath(real)) throw new Error("Credential, secret, key, database and .git files are never sent to chat.")

  const served = mediaRoots(ctx).some((root) => isInside(root, real))
  const allowedHere = served
    || options.allowOutsideWorkspace === true
    || (options.extraAllowedRoots ?? []).some((root) => isInside(realOrResolved(root), real))
  if (!allowedHere) {
    throw new Error("That file is outside the workspace and restrict_to_workspace is on. Copy it into the workspace first, then send the copy.")
  }

  const known = describeFile(real)
  if (served && known) {
    const attachment = toAttachment(real)
    if (!attachment) throw new Error("This file type cannot be shown in chat.")
    return { attachment, sizeBytes: stat.size, copied: false }
  }

  const info = known ?? { ...GENERIC_FILE }
  const outbox = path.join(realOrResolved(ctx.workspaceRoot), OUTBOX_DIR)
  fs.mkdirSync(outbox, { recursive: true })
  const digest = (await sha256File(real)).slice(0, 16)
  const target = path.join(outbox, `${digest}-${safeFileName(path.basename(real))}`)
  if (!fs.existsSync(target)) {
    try {
      fs.copyFileSync(real, target, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(target, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`Could not stage the file for chat: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    attachment: {
      type: info.type,
      url: `${MEDIA_ROUTE}?path=${encodeURIComponent(realOrResolved(target))}`,
      filename: path.basename(real),
      content_type: info.contentType,
    },
    sizeBytes: stat.size,
    copied: true,
  }
}
