import {
  IconCheck,
  IconCopy,
  IconDots,
  IconGitFork,
  IconPencil,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react"
import { type ReactNode, memo } from "react"

import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { cn } from "@/lib/utils"
import { Button } from "@/shared/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu"

import type { MessageActionLabels } from "./use-message-action-labels"

interface MessageActionBarProps {
  content: string
  labels: MessageActionLabels
  modelName?: string
  align?: "start" | "end"
  placement?: "floating" | "inline"
  className?: string
  visible?: boolean
  subtle?: boolean
  canRetry?: boolean
  onEdit?: () => void
  onDelete?: () => void
  onFork?: () => void
  onRetry?: () => void
  onInspect?: () => void
}

function ActionButton({
  label,
  title,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  title?: string
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/25 size-6 rounded-sm border-0 bg-transparent hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-2 pointer-coarse:size-8"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
    >
      {children}
    </Button>
  )
}

export const MessageActionBar = memo(function MessageActionBar({
  content,
  labels,
  modelName,
  align = "end",
  placement = "floating",
  className,
  visible = false,
  subtle = false,
  canRetry = true,
  onEdit,
  onDelete,
  onFork,
  onRetry,
  onInspect,
}: MessageActionBarProps) {
  const { copy, isCopied } = useCopyToClipboard()
  const primaryAction = onEdit
    ? {
        label: labels.edit,
        run: onEdit,
        icon: <IconPencil className="size-3.5" />,
      }
    : onRetry
      ? {
          label: labels.retry,
          title: canRetry ? labels.retry : labels.retryDisabled,
          run: onRetry,
          icon: <IconRefresh className="size-3.5" />,
          disabled: !canRetry,
        }
      : undefined
  // When Edit is the primary action, Retry moves into the overflow menu so no capability is lost.
  const retryInOverflow = Boolean(onEdit && onRetry)
  const hasOverflowActions = Boolean(
    retryInOverflow || onFork || onDelete || onInspect || modelName,
  )

  return (
    <div
      data-chat-message-actions
      className={cn(
        "flex w-max max-w-[min(13rem,calc(100vw-2rem))] items-center transition-[height,opacity] duration-150",
        placement === "floating"
          ? "pointer-events-none absolute top-full z-20 mt-0.5 h-7 opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-hover/message-bubble:pointer-events-auto group-hover/message-bubble:opacity-100"
          : "pointer-events-none h-0 overflow-hidden opacity-0 group-focus-within/message:pointer-events-auto group-focus-within/message:h-7 group-focus-within/message:overflow-visible group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:h-7 group-hover/message:overflow-visible group-hover/message:opacity-100",
        visible && "pointer-events-auto h-7 overflow-visible opacity-100",
        subtle && "opacity-60 hover:opacity-100",
        align === "end" ? "justify-end" : "justify-start",
        className,
      )}
    >
      <div className="flex h-7 w-max max-w-full items-center gap-0 overflow-visible bg-transparent px-0">
        {primaryAction && (
          <ActionButton
            label={primaryAction.label}
            title={"title" in primaryAction ? primaryAction.title : undefined}
            disabled={
              "disabled" in primaryAction ? primaryAction.disabled : false
            }
            onClick={primaryAction.run}
          >
            {primaryAction.icon}
          </ActionButton>
        )}
        <ActionButton
          label={isCopied ? labels.copied : labels.copy}
          onClick={() => void copy(content)}
        >
          {isCopied ? (
            <IconCheck className="text-success size-3.5" />
          ) : (
            <IconCopy className="size-3.5" />
          )}
        </ActionButton>

        {hasOverflowActions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={labels.moreActions}
                title={labels.moreActions}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/25 size-6 rounded-sm border-0 bg-transparent hover:bg-transparent focus-visible:ring-2 pointer-coarse:size-8"
              >
                <IconDots className="size-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align={align === "end" ? "end" : "start"}
              className="min-w-44"
            >
              {retryInOverflow && (
                <DropdownMenuItem onSelect={onRetry} disabled={!canRetry}>
                  <IconRefresh aria-hidden="true" />
                  {canRetry ? labels.retry : labels.retryDisabled}
                </DropdownMenuItem>
              )}
              {onFork && (
                <DropdownMenuItem onSelect={onFork}>
                  <IconGitFork aria-hidden="true" />
                  {labels.fork}
                </DropdownMenuItem>
              )}
              {onInspect && (
                <DropdownMenuItem onSelect={onInspect}>
                  <IconSearch aria-hidden="true" />
                  {labels.inspect}
                </DropdownMenuItem>
              )}
              {modelName && (
                <DropdownMenuItem
                  disabled
                  className="font-mono text-xs opacity-80"
                >
                  {labels.model}: {modelName}
                </DropdownMenuItem>
              )}
              {onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                    <IconTrash aria-hidden="true" />
                    {labels.delete}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
})
