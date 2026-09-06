import { launcherFetch } from "@/api/http"

export type LinkPreviewProvider =
  "youtube" | "x" | "instagram" | "tiktok" | "web"

export interface LinkPreview {
  url: string
  provider: LinkPreviewProvider
  title: string
  description?: string
  image?: string
  siteName?: string
  unavailable?: boolean
}

export async function fetchLinkPreview(url: string): Promise<LinkPreview> {
  const params = new URLSearchParams({ url })
  const response = await launcherFetch(`/api/link-preview?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Link preview request failed (${response.status})`)
  }
  return (await response.json()) as LinkPreview
}
