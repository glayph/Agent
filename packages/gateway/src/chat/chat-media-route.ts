import path from "node:path"
import type express from "express"
import { describeFile, resolveMediaPath, type AttachmentContext } from "./chat-attachments.js"

/**
 * GET handler for files shown in chat. Only files under the served roots are sent
 * (see resolveMediaPath); video and audio support Range requests so players can seek.
 */
export function createChatMediaHandler(getContext: () => AttachmentContext): express.RequestHandler {
  return (req, res) => {
    const requested = typeof req.query.path === "string" ? req.query.path : ""
    const file = resolveMediaPath(requested, getContext())
    // resolveMediaPath only lets unknown types through from the outbox, so the fallback is safe here.
    const info = file ? describeFile(file, { fallback: true }) : null
    if (!file || !info) return void res.status(404).json({ error: "Attachment not found." })
    res.setHeader("Content-Type", info.contentType)
    res.setHeader("X-Content-Type-Options", "nosniff")
    // Sandboxed so a served .html/.svg can never run script with the dashboard session.
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'")
    res.setHeader("Cache-Control", "private, max-age=300")
    if (req.query.download === "1" || info.contentType === "application/octet-stream") {
      // Outbox copies are stored as "<hash>-<name>"; downloads keep the original name, including non-ASCII names.
      const shown = path.basename(file).replace(/^[0-9a-f]{16}-/, "")
      const ascii = shown.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "")
      res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(shown)}`)
    }
    res.sendFile(file)
  }
}
