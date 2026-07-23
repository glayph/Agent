import ReactMarkdown from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import rehypeSanitize from "rehype-sanitize"
import remarkGfm from "remark-gfm"

import { MarkdownCodeBlock } from "@/features/chat/components/message-code-block"

const MARKDOWN_REMARK_PLUGINS = [remarkGfm]
const MARKDOWN_REHYPE_PLUGINS = [rehypeHighlight, rehypeSanitize]

interface MarkdownRendererProps {
  content: string
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      components={{
        pre: MarkdownCodeBlock,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
