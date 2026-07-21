import { IconCheck, IconChevronDown, IconCopy } from "@tabler/icons-react"
import { useAtom } from "jotai"
import {
  type CSSProperties,
  type ComponentProps,
  type ReactNode,
  useMemo,
  useState,
} from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/shared/ui/button"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { cn } from "@/lib/utils"
import { codeBlockWrapAtom } from "@/store/code-block"

import {
  type MarkdownNode,
  extractCodeBlockFromPreNode,
  extractCodeBlockRenderState,
  splitCodeIntoLines,
  splitRenderedCodeContentIntoLines,
  trimTrailingEmptyRenderedCodeLine,
  trimTrailingEmptyStringLine,
} from "./message-code-block.utils"

const CODE_LABEL_FONT_FAMILY =
  'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", monospace'

interface MessageCodeBlockProps {
  code: string
  language?: string | null
  label?: string
  className?: string
  bodyClassName?: string
  children?: ReactNode
  trimTrailingEmptyLine?: boolean
}

interface MarkdownCodeBlockProps extends ComponentProps<"pre"> {
  node?: MarkdownNode
}

export function MessageCodeBlock({
  code,
  language = null,
  label,
  className,
  bodyClassName,
  children,
  trimTrailingEmptyLine = false,
}: MessageCodeBlockProps) {
  const { t } = useTranslation()
  const { copy, isCopied } = useCopyToClipboard()
  const [wrapLongLines, setWrapLongLines] = useAtom(codeBlockWrapAtom)
  const [isExpanded, setIsExpanded] = useState(true)
  const blockLabel =
    label ??
    (language
      ? language.toLocaleLowerCase()
      : t("chat.codeLabel").toLocaleLowerCase())
  const copyLabel = isCopied ? t("chat.copiedLabel") : t("chat.copyCode")
  const expandLabel = isExpanded ? t("chat.collapseCode") : t("chat.expandCode")
  const wrapLabel = wrapLongLines
    ? t("chat.disableCodeWrap")
    : t("chat.enableCodeWrap")
  const renderedCodeState = useMemo(
    () =>
      children
        ? extractCodeBlockRenderState(children)
        : {
            renderedContent: null,
            className: undefined,
          },
    [children],
  )
  const codeLines = useMemo(() => {
    if (children) {
      const renderedLines = splitRenderedCodeContentIntoLines(
        renderedCodeState.renderedContent,
      )
      return trimTrailingEmptyLine
        ? trimTrailingEmptyRenderedCodeLine(renderedLines)
        : renderedLines
    }

    const plainLines = splitCodeIntoLines(code)
    return trimTrailingEmptyLine
      ? trimTrailingEmptyStringLine(plainLines)
      : plainLines
  }, [children, code, renderedCodeState.renderedContent, trimTrailingEmptyLine])
  const lineNumberWidth = `${String(codeLines.length).length + 1}ch`
  const codeLineStyle = useMemo(
    () =>
      ({
        "--code-line-number-width": lineNumberWidth,
      }) as CSSProperties,
    [lineNumberWidth],
  )

  return (
    <div
      data-Hiro-code-block=""
      className={cn(
        "not-prose bg-muted/50 text-foreground my-2.5 overflow-hidden rounded-md shadow-none",
        className,
      )}
    >
      <div className="bg-background/35 flex items-center justify-between gap-2 px-2.5 py-1.5">
        <span
          className="text-muted-foreground text-[10.5px] font-medium"
          style={{ fontFamily: CODE_LABEL_FONT_FAMILY }}
        >
          {blockLabel}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:bg-accent/70 hover:text-foreground h-6 px-1.5 text-[11px]"
            onClick={() => void copy(code)}
            aria-label={copyLabel}
            title={copyLabel}
          >
            {isCopied ? <IconCheck className="text-green-500" /> : <IconCopy />}
            <span className="hidden sm:inline">{copyLabel}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:bg-accent/70 hover:text-foreground h-6 px-1.5 text-[11px]"
            onClick={() => setWrapLongLines((current) => !current)}
            aria-pressed={wrapLongLines}
            aria-label={wrapLabel}
            title={wrapLabel}
          >
            {wrapLabel}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:bg-accent/70 hover:text-foreground h-6 px-1.5 text-[11px]"
            onClick={() => setIsExpanded((expanded) => !expanded)}
            aria-expanded={isExpanded}
            aria-label={expandLabel}
            title={expandLabel}
          >
            <IconChevronDown
              className={cn(
                "transition-transform duration-200",
                isExpanded && "rotate-180",
              )}
            />
            <span className="hidden sm:inline">{expandLabel}</span>
          </Button>
        </div>
      </div>

      {isExpanded && (
        <pre
          className={cn(
            "m-0 max-h-[24rem] overflow-auto bg-transparent px-3 py-2.5 font-mono text-[12px] leading-5",
            bodyClassName,
          )}
        >
          <code
            className={cn(
              "block bg-transparent p-0 text-inherit",
              children
                ? renderedCodeState.className
                : cn(language && `language-${language}`),
            )}
          >
            {codeLines.map((line, index) => (
              <span
                key={`${index}-${line.length}`}
                className="grid grid-cols-[var(--code-line-number-width)_minmax(0,1fr)] items-start gap-x-3"
                style={codeLineStyle}
              >
                <span className="bg-muted text-muted-foreground/55 sticky left-0 z-1 text-right select-none">
                  {index + 1}
                </span>
                <span
                  className={cn(
                    "min-w-0",
                    wrapLongLines
                      ? "break-words whitespace-pre-wrap"
                      : "whitespace-pre",
                  )}
                >
                  {line}
                </span>
              </span>
            ))}
          </code>
        </pre>
      )}
    </div>
  )
}

export function MarkdownCodeBlock({
  children,
  className,
  node,
}: MarkdownCodeBlockProps) {
  const { code, language } = extractCodeBlockFromPreNode(node)

  return (
    <MessageCodeBlock
      code={code}
      language={language}
      bodyClassName={className}
      trimTrailingEmptyLine
    >
      {children}
    </MessageCodeBlock>
  )
}
