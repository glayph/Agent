import {
  IconCheck,
  IconCopy,
  IconGitFork,
  IconInfoCircle,
  IconPencil,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react"
import { type ReactNode, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog"
import { Button } from "@/shared/ui/button"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { cn } from "@/lib/utils"

interface MessageActionBarProps {
  content: string
  copyLabel: string
  copiedLabel: string
  editLabel: string
  deleteLabel: string
  forkLabel: string
  retryLabel: string
  retryDisabledLabel?: string
  deleteConfirmTitle?: string
  deleteConfirmDescription?: string
  deleteConfirmCancelLabel?: string
  deleteConfirmActionLabel?: string
  modelLabel?: string
  align?: "start" | "end"
  placement?: "floating" | "inline"
  className?: string
  visible?: boolean
  canRetry?: boolean
  onEdit?: () => void
  onDelete?: () => void
  onFork?: () => void
  onRetry?: () => void
}

function MetadataIcon({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <span
      tabIndex={0}
      role="img"
      aria-label={label}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/25 inline-flex size-6 items-center justify-center rounded-md border-0 bg-transparent outline-none focus-visible:ring-2"
    >
      {children}
    </span>
  )
}

function ActionButton({
  label,
  title,
  disabled = false,
  destructive = false,
  onClick,
  children,
}: {
  label: string
  title?: string
  disabled?: boolean
  destructive?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:ring-ring/25 size-6 rounded-md border-0 bg-transparent hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-2",
        destructive &&
          "text-destructive/80 hover:text-destructive hover:bg-transparent",
      )}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
    >
      {children}
    </Button>
  )
}

export function MessageActionBar({
  content,
  copyLabel,
  copiedLabel,
  editLabel,
  deleteLabel,
  forkLabel,
  retryLabel,
  retryDisabledLabel,
  deleteConfirmTitle,
  deleteConfirmDescription,
  deleteConfirmCancelLabel,
  deleteConfirmActionLabel,
  modelLabel,
  align = "end",
  placement = "floating",
  className,
  visible = false,
  canRetry = true,
  onEdit,
  onDelete,
  onFork,
  onRetry,
}: MessageActionBarProps) {
  const { t } = useTranslation()
  const { copy, isCopied } = useCopyToClipboard()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const copyMessageLabel = isCopied ? copiedLabel : copyLabel
  const retryTitle = canRetry ? retryLabel : (retryDisabledLabel ?? retryLabel)

  return (
    <div
      data-chat-message-actions
      className={cn(
        "flex w-max max-w-[min(13rem,calc(100vw-2rem))] transition-[height,opacity] duration-150",
        placement === "floating"
          ? "pointer-events-none absolute top-full z-20 mt-0.5 h-6 opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-focus-within/message-bubble:pointer-events-auto group-focus-within/message-bubble:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-hover/message-bubble:pointer-events-auto group-hover/message-bubble:opacity-100"
          : "pointer-events-none h-0 overflow-hidden opacity-0 group-focus-within/message:pointer-events-auto group-focus-within/message:h-6 group-focus-within/message:overflow-visible group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:h-6 group-hover/message:overflow-visible group-hover/message:opacity-100",
        visible && "pointer-events-auto h-6 overflow-visible opacity-100",
        align === "end" ? "justify-end" : "justify-start",
        className,
      )}
    >
      <div className="flex h-6 w-max max-w-full items-center gap-0.5 overflow-visible bg-transparent px-0.5">
        {onEdit && (
          <ActionButton label={editLabel} onClick={onEdit}>
            <IconPencil className="size-3.5" />
          </ActionButton>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/25 size-6 rounded-md border-0 bg-transparent hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-2"
          onClick={() => void copy(content)}
          aria-label={copyMessageLabel}
          title={copyMessageLabel}
        >
          {isCopied ? (
            <IconCheck className="text-success size-3.5" />
          ) : (
            <IconCopy className="size-3.5" />
          )}
        </Button>
        {onRetry && (
          <ActionButton
            label={retryLabel}
            title={retryTitle}
            onClick={onRetry}
            disabled={!canRetry}
          >
            <IconRefresh className="size-3.5" />
          </ActionButton>
        )}
        {onFork && (
          <ActionButton label={forkLabel} onClick={onFork}>
            <IconGitFork className="size-3.5" />
          </ActionButton>
        )}
        {onDelete && (
          <>
            <ActionButton
              label={deleteLabel}
              onClick={() => setDeleteDialogOpen(true)}
              destructive
            >
              <IconTrash className="size-3.5" />
            </ActionButton>
            <AlertDialog
              open={deleteDialogOpen}
              onOpenChange={setDeleteDialogOpen}
            >
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {deleteConfirmTitle ?? deleteLabel}
                  </AlertDialogTitle>
                  {deleteConfirmDescription && (
                    <AlertDialogDescription>
                      {deleteConfirmDescription}
                    </AlertDialogDescription>
                  )}
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>
                    {deleteConfirmCancelLabel ?? t("common.cancel")}
                  </AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={onDelete}>
                    {deleteConfirmActionLabel ?? deleteLabel}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
        {modelLabel && (
          <MetadataIcon label={modelLabel}>
            <IconInfoCircle className="size-3.5" />
          </MetadataIcon>
        )}
      </div>
    </div>
  )
}
