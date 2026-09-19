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
