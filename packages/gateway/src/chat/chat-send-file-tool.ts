import type { EngineTool } from "@miki/core/engine"
import {
  SEND_FILE_TOOL,
  stageChatFile,
  type AttachmentContext,
  type ChatAttachmentPayload,
  type StageOptions,
} from "./chat-attachments.js"

/** One message the agent wants shown in the user's chat. */
export interface ChatMediaDelivery {
  runId: string
  sessionId?: string
  /** Text written by the model that goes with the files; may be empty. */
  caption: string
  attachments: ChatAttachmentPayload[]
}

export interface ChatSendFileToolOptions {
  /** Served roots (workspace + screenshots); the media route only serves files below these. */
  getContext: () => AttachmentContext
  /** Folder relative paths resolve against: the agent's working workspace. */
  getBaseDir?: () => string
  /** Sending from outside the workspace is allowed only when the agent itself may read there. */
  allowOutsideWorkspace: () => boolean
  /** Persists the message and shows it in the chat (live or as a proactive message). */
  deliver: (delivery: ChatMediaDelivery) => Promise<void> | void
}

/** Most files one call can send; they arrive together in a single chat message. */
export const MAX_FILES_PER_SEND = 10

function requestedPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = []
  if (typeof input.path === "string" && input.path.trim()) paths.push(input.path.trim())
  if (Array.isArray(input.paths)) {
    for (const item of input.paths) {
      if (typeof item !== "string") throw new Error('"paths" must be a list of file path strings.')
      if (item.trim()) paths.push(item.trim())
    }
  }
  return [...new Set(paths)]
}

/**
 * chat_send_file: the way Miki puts a real file in front of the user.
 * Images and screenshots are shown inline, video and audio get a player, anything else
 * (PDF, Office documents, archives, code, data) becomes a download card.
 */
export function createChatSendFileTool(options: ChatSendFileToolOptions): EngineTool {
  return {
    name: SEND_FILE_TOOL,
    description:
      "Send one or more existing files to the user's chat window as a message. Use it whenever the user should receive, see, hear or download a result: "
      + "an image or screenshot (shown inline), a video or audio clip (playable in chat), a PDF, Word/Excel/PowerPoint document, archive, spreadsheet, code or any other file. "
      + "Create the file first (terminal_run, file_write, browser_screenshot, ...), then call this with its path. Relative paths resolve against the workspace. "
      + "The files appear as their own chat message right away, even while you keep working. "
      + "'caption' is the message text shown with the files: write it in the user's language and do not repeat it in your final answer. "
      + "Credential, secret, key and database files are never sent.",
    risk: "read",
    approval: "auto",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to send." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: `Several files to send together in one message (up to ${MAX_FILES_PER_SEND}).`,
        },
        caption: { type: "string", description: "Optional message text to show with the file(s)." },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const requested = requestedPaths(input)
      if (requested.length === 0) throw new Error('Provide "path" (one file) or "paths" (several files).')
      if (requested.length > MAX_FILES_PER_SEND) {
        throw new Error(`At most ${MAX_FILES_PER_SEND} files can be sent in one call; send the rest in another call.`)
      }
      const caption = typeof input.caption === "string" ? input.caption.trim() : ""
      const ctx = options.getContext()
      const baseDir = options.getBaseDir?.()
      const stageOptions: StageOptions = {
        allowOutsideWorkspace: options.allowOutsideWorkspace(),
        ...(baseDir ? { baseDir, extraAllowedRoots: [baseDir] } : {}),
      }

      const staged = []
      for (const raw of requested) {
        context.heartbeat?.(`Preparing ${raw}`)
        // All-or-nothing: one bad path fails the call before anything reaches the chat.
        staged.push(await stageChatFile(raw, ctx, stageOptions))
      }

      await options.deliver({
        runId: context.runId,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        caption,
        attachments: staged.map((item) => item.attachment),
      })

      return {
        delivered: true,
        confirmed: true,
        files: staged.map((item) => ({
          filename: item.attachment.filename,
          type: item.attachment.type,
          contentType: item.attachment.content_type,
          sizeBytes: item.sizeBytes,
        })),
        note: "The file(s) are now visible in the user's chat as a separate message.",
      }
    },
  }
}
