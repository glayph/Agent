import type { Components } from "react-markdown"
import ReactMarkdown from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import rehypeSanitize from "rehype-sanitize"
import remarkGfm from "remark-gfm"

import { MarkdownCodeBlock } from "@/features/chat/components/message-code-block"

const MARKDOWN_REMARK_PLUGINS = [remarkGfm]
const MARKDOWN_REHYPE_PLUGINS = [rehypeHighlight, rehypeSanitize]

interface MarkdownRendererProps {
  content: string
  streaming?: boolean
}

const markdownComponents: Components = {
  pre: MarkdownCodeBlock,
  a: ({ href, children, ...props }) => (
    <a
      href={href}
      target={href?.startsWith("http") ? "_blank" : undefined}
      rel={href?.startsWith("http") ? "noreferrer noopener" : undefined}
      className="text-[var(--text-link)] underline decoration-from-font underline-offset-2 [overflow-wrap:anywhere]"
      {...props}
    >
      {children}
    </a>
  ),
  table: ({ children, ...props }) => (
    <div className="my-3 max-w-full overflow-x-auto rounded-lg border border-[color-mix(in_srgb,var(--border)_70%,transparent)]">
      <table className="w-full min-w-[16rem] border-collapse text-[0.9em]" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }) => (
    <th
      className="bg-muted/40 border-border/60 border px-2.5 py-1.5 text-left font-semibold"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border-border/60 border px-2.5 py-1.5 align-top" {...props}>
      {children}
    </td>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = typeof className === "string" && className.includes("language-")
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code
        className="bg-muted/55 rounded-md px-1.5 py-0.5 font-mono text-[0.9em] [overflow-wrap:anywhere]"
        {...props}
      >
        {children}
      </code>
    )
  },
}

export default function MarkdownRenderer({ content, streaming = false }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={streaming ? [rehypeSanitize] : MARKDOWN_REHYPE_PLUGINS}
      components={markdownComponents}
    >
      {content}
    </ReactMarkdown>
  )
}
