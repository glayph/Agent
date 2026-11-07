import {
  IconDownload,
  IconFileText,
  IconMusic,
  IconPhoto,
  IconVideo,
  IconX,
} from "@tabler/icons-react"

import type { ChatAttachment } from "@/store/chat"

interface AttachmentCardProps {
  attachment: ChatAttachment
  removeLabel?: string
  downloadLabel?: string
  onRemove?: () => void
}

function attachmentLabel(attachment: ChatAttachment): string {
  if (attachment.contentType?.includes("audio")) return "AUDIO"
  if (attachment.contentType?.includes("video")) return "VIDEO"
  if (attachment.contentType?.includes("image")) return "IMAGE"
  const extension = attachment.filename?.split(".").pop()?.trim()
  return extension ? extension.toUpperCase() : "FILE"
}

function AttachmentIcon({ attachment }: { attachment: ChatAttachment }) {
  if (attachment.type === "image") return <IconPhoto className="size-5" />
  if (attachment.type === "audio") return <IconMusic className="size-5" />
  if (attachment.type === "video") return <IconVideo className="size-5" />
  return <IconFileText className="size-5" />
}

export function AttachmentCard({
  attachment,
  removeLabel = "Remove attachment",
  downloadLabel = "Download attachment",
  onRemove,
}: AttachmentCardProps) {
  const filename = attachment.filename || "Untitled file"
  const metadata = attachmentLabel(attachment)
  const cardClassName =
    "group/attachment bg-card/90 border-border/50 hover:bg-muted/30 flex min-w-0 max-w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 shadow-xs transition-colors"

  const body = (
    <>
      {attachment.type === "image" ? (
        <img
          src={attachment.url}
          alt={filename}
          width={44}
          height={44}
          loading="lazy"
          decoding="async"
          className="size-11 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <span className="bg-primary/10 text-primary flex size-11 shrink-0 items-center justify-center rounded-lg">
          <AttachmentIcon attachment={attachment} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground truncate text-[13px] leading-5 font-medium">
          {filename}
        </span>
        <span className="text-muted-foreground text-[10px] leading-4 font-medium tracking-wide">
          {metadata}
        </span>
      </span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive flex size-7 shrink-0 items-center justify-center rounded-full transition-colors"
          aria-label={removeLabel}
          title={removeLabel}
        >
          <IconX className="size-4" />
        </button>
      ) : (
        <span className="bg-muted text-muted-foreground group-hover/attachment:bg-primary group-hover/attachment:text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full transition-colors">
          <IconDownload className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{downloadLabel}</span>
        </span>
      )}
    </>
  )

  if (onRemove) return <div className={cardClassName}>{body}</div>

  return (
    <a
      href={attachment.url}
      download={filename}
      target={attachment.type === "image" ? "_blank" : undefined}
      rel={attachment.type === "image" ? "noreferrer" : undefined}
      className={cardClassName}
      aria-label={`${downloadLabel}: ${filename}`}
    >
      {body}
    </a>
  )
}

interface MediaPlayerAttachmentProps {
  attachment: ChatAttachment
  downloadLabel?: string
}

/** Inline player for video and audio, with a download link underneath. */
export function MediaPlayerAttachment({
  attachment,
  downloadLabel = "Download attachment",
}: MediaPlayerAttachmentProps) {
  const filename = attachment.filename || "Untitled file"
  return (
    <div className="bg-card/90 border-border/50 flex max-w-full min-w-0 flex-col gap-1.5 rounded-xl border p-2 shadow-xs">
      {attachment.type === "video" ? (
        <video
          controls
          playsInline
          preload="metadata"
          src={attachment.url}
          aria-label={filename}
          className="max-h-80 w-full max-w-[420px] rounded-lg bg-black"
        />
      ) : (
        <audio
          controls
          preload="metadata"
          src={attachment.url}
          aria-label={filename}
          className="w-full max-w-[420px] min-w-[240px]"
        />
      )}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-foreground truncate text-[12px] leading-5 font-medium">
          {filename}
        </span>
        <a
          href={attachment.url}
          download={filename}
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          aria-label={`${downloadLabel}: ${filename}`}
          title={downloadLabel}
        >
          <IconDownload className="size-4" aria-hidden="true" />
        </a>
      </div>
    </div>
  )
}
