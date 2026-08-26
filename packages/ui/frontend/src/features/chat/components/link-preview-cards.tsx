import { useEffect, useMemo, useState } from "react"

import { type LinkPreview, fetchLinkPreview } from "@/api/link-preview"

interface LinkPreviewCardsProps {
  content: string
}

const SOCIAL_HOSTS = [
  "youtube.com",
  "youtu.be",
  "x.com",
  "twitter.com",
  "instagram.com",
  "tiktok.com",
]

function isSocialUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return SOCIAL_HOSTS.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
    )
  } catch {
    return false
  }
}

function extractSocialUrls(content: string): string[] {
  const candidates = content.match(/https?:\/\/[^\s<>()\[\]"']+/gi) ?? []
  const normalized = candidates
    .map((value) => value.replace(/[.,!?;:)]+$/g, ""))
    .filter(isSocialUrl)
  return [...new Set(normalized)].slice(0, 3)
}

function providerLabel(provider: LinkPreview["provider"]): string {
  switch (provider) {
    case "youtube":
      return "YouTube"
    case "x":
      return "X"
    case "instagram":
      return "Instagram"
    case "tiktok":
      return "TikTok"
    default:
      return "Link"
  }
}

export function LinkPreviewCards({ content }: LinkPreviewCardsProps) {
  const urls = useMemo(() => extractSocialUrls(content), [content])
  const [previews, setPreviews] = useState<LinkPreview[]>([])

  useEffect(() => {
    let cancelled = false
    if (urls.length === 0) {
      setPreviews([])
      return () => {
        cancelled = true
      }
    }
    void Promise.all(
      urls.map(async (url) => {
        try {
          return await fetchLinkPreview(url)
        } catch {
          return {
            url,
            provider: "web" as const,
            title: "Preview unavailable",
            unavailable: true,
          }
        }
      }),
    ).then((results) => {
      if (!cancelled) setPreviews(results)
    })
    return () => {
      cancelled = true
    }
  }, [urls])

  if (urls.length === 0 || previews.length === 0) return null

  return (
    <div className="mt-2 flex flex-col gap-2" data-link-preview-list="true">
      {previews.map((preview) => (
        <a
          key={preview.url}
          href={preview.url}
          target="_blank"
          rel="noreferrer"
          className="border-border/70 bg-muted/20 hover:bg-muted/40 focus-visible:ring-ring/30 flex max-w-xl overflow-hidden rounded-lg border transition-colors focus-visible:ring-2 focus-visible:outline-none"
          data-link-preview={preview.provider}
        >
          {preview.image && !preview.unavailable ? (
            <img
              src={preview.image}
              alt=""
              className="h-20 w-28 shrink-0 object-cover"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : null}
          <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
            <span className="text-muted-foreground text-[10px] font-semibold tracking-wide uppercase">
              {providerLabel(preview.provider)}
            </span>
            <span className="text-foreground line-clamp-2 text-sm font-medium">
              {preview.title}
            </span>
            {preview.description ? (
              <span className="text-muted-foreground line-clamp-2 text-xs">
                {preview.description}
              </span>
            ) : null}
            {preview.unavailable ? (
              <span className="text-muted-foreground text-[11px]">
                Preview unavailable; open the link directly.
              </span>
            ) : null}
          </span>
        </a>
      ))}
    </div>
  )
}
