import {
  IconBrain,
  IconDatabase,
  IconRefresh,
  IconSearch,
  IconShieldCheck,
  IconTrash,
} from "@tabler/icons-react"
import { useCallback, useEffect, useState } from "react"
import type { FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  type MemoryChunk,
  type MemoryItem,
  type MemorySearchResult,
  type MemoryStats,
  forgetMemoryChunk,
  getMemoryStats,
  inspectMemoryChunk,
  listMemoryChunks,
  reindexMemory,
  searchMemory,
} from "@/api/memory"
import { PageHeader } from "@/app/layout/page-header"
import { formatDateTime } from "@/lib/format"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card"
import { Input } from "@/shared/ui/input"
import { SectionPanel } from "@/shared/ui/minimal-primitives"
import { Skeleton } from "@/shared/ui/skeleton"

const REGIONS = [
  "all",
  "long_term",
  "day_to_day",
  "static",
  "skill",
  "rule_emotion",
]

function scoreLabel(value: number) {
  return `${Math.round(value * 100)}%`
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string
  value: string | number
  detail?: string
}) {
  return (
    <Card size="sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-xs tracking-wide uppercase">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        {detail && (
          <div className="text-muted-foreground mt-1 text-xs">{detail}</div>
        )}
      </CardContent>
    </Card>
  )
}

function MemoryItemRow({
  item,
  onInspect,
}: {
  item: MemoryItem
  onInspect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onInspect(item.id)}
      className="border-border hover:bg-muted/50 w-full rounded-lg border p-3 text-left transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{item.region}</Badge>
            <Badge variant="outline">{item.provenance}</Badge>
            <span className="text-muted-foreground text-xs">
              depth {item.depth}
            </span>
          </div>
          <p className="text-sm leading-6">{item.text}</p>
        </div>
        <div className="text-muted-foreground shrink-0 text-right text-xs">
          <div className="text-foreground font-semibold">
            {scoreLabel(item.score)}
          </div>
          <div>score</div>
        </div>
      </div>
    </button>
  )
}

export function MemoryPage() {
  const { t } = useTranslation()
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [chunks, setChunks] = useState<MemoryChunk[]>([])
  const [region, setRegion] = useState("all")
  const [query, setQuery] = useState("")
  const [searchResult, setSearchResult] = useState<MemorySearchResult | null>(
    null,
  )
  const [selected, setSelected] = useState<
    (MemoryChunk & { edges: Array<Record<string, unknown>> }) | null
  >(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [statsResponse, chunksResponse] = await Promise.all([
        getMemoryStats(),
        listMemoryChunks({
          region: region === "all" ? undefined : region,
          limit: 80,
        }),
      ])
      setStats(statsResponse.stats)
      setChunks(chunksResponse.chunks)
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t("pages.memory.load_error", {
              defaultValue: "Unable to load memory diagnostics.",
            })
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [region, t])

  useEffect(() => {
    void load()
  }, [load])

  const inspect = async (chunkId: string) => {
    try {
      setSelected((await inspectMemoryChunk(chunkId)).chunk)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Unable to inspect memory chunk.",
      )
    }
  }

  const submitSearch = async (event: FormEvent) => {
    event.preventDefault()
    if (!query.trim()) return
    setBusy("search")
    try {
      setSearchResult(
        await searchMemory(query.trim(), {
          maxSelected: 12,
          maxDepth: 2,
          maxTokens: 1200,
        }),
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Memory search failed.")
    } finally {
      setBusy(null)
    }
  }

  const runReindex = async () => {
    setBusy("reindex")
    try {
      const result = await reindexMemory()
      toast.success(`Reindexed ${result.result.reindexed} chunks.`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reindex failed.")
    } finally {
      setBusy(null)
    }
  }

  const forget = async () => {
    if (
      !selected ||
      !window.confirm(
        t("pages.memory.forget_confirm", {
          defaultValue:
            "Forget this memory chunk? It will be excluded from future retrieval.",
        }),
      )
    )
      return
    setBusy("forget")
    try {
      await forgetMemoryChunk(selected.id)
      toast.success(
        t("pages.memory.forgotten", {
          defaultValue: "Memory chunk forgotten.",
        }),
      )
      setSelected(null)
      await load()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Forget operation failed.",
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("pages.memory.title", { defaultValue: "Memory" })}
        titleExtra={
          <Badge variant="secondary">
            <IconBrain className="mr-1 size-3" /> selective retrieval
          </Badge>
        }
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
        >
          <IconRefresh data-icon="inline-start" />
          {t("common.refresh", { defaultValue: "Refresh" })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void runReindex()}
          disabled={busy !== null}
        >
          <IconDatabase data-icon="inline-start" />
          {t("pages.memory.reindex", { defaultValue: "Reindex" })}
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {error && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive mb-4 rounded-lg border px-3 py-2 text-sm"
          >
            {error}
          </div>
        )}
        {loading && !stats ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-28 rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Metric
                label="Chunks"
                value={stats?.chunks ?? 0}
                detail="active selective records"
              />
              <Metric
                label="Postings"
                value={stats?.postings ?? 0}
                detail="inverted index entries"
              />
              <Metric
                label="Graph edges"
                value={stats?.edges ?? 0}
                detail="bounded traversal links"
              />
              <Metric
                label="Retrievals"
                value={stats?.retrievals ?? 0}
                detail="diagnostic traces"
              />
            </div>

            <SectionPanel
              title={t("pages.memory.search_title", {
                defaultValue: "Selective memory search",
              })}
              description={t("pages.memory.search_description", {
                defaultValue:
                  "Search is scoped to the active runtime and returns only bounded, scored chunks.",
              })}
            >
              <form
                onSubmit={submitSearch}
                className="flex flex-col gap-2 sm:flex-row"
              >
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("pages.memory.search_placeholder", {
                    defaultValue:
                      "Search remembered facts, tasks, rules, or skills…",
                  })}
                  aria-label="Memory search"
                />
                <Button type="submit" disabled={busy !== null || !query.trim()}>
                  <IconSearch data-icon="inline-start" />
                  Search
                </Button>
              </form>
              {searchResult && (
                <div className="mt-4 space-y-2">
                  <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                    <span>
                      {searchResult.result.stats.selectedCount} selected
                    </span>
                    <span>·</span>
                    <span>
                      {searchResult.result.stats.candidateCount} candidates
                    </span>
                    <span>·</span>
                    <span>
                      {searchResult.result.stats.tokensUsed}/
                      {searchResult.result.stats.maxTokens} tokens
                    </span>
                    <span>·</span>
                    <span>{searchResult.result.stats.latencyMs} ms</span>
                  </div>
                  {searchResult.result.items.length ? (
                    searchResult.result.items.map((item) => (
                      <MemoryItemRow
                        key={item.id}
                        item={item}
                        onInspect={(id) => void inspect(id)}
                      />
                    ))
                  ) : (
                    <div className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
                      No selective matches.
                    </div>
                  )}
                </div>
              )}
            </SectionPanel>

            <div className="grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
              <SectionPanel
                title={t("pages.memory.chunks_title", {
                  defaultValue: "Memory chunks",
                })}
                description={t("pages.memory.chunks_description", {
                  defaultValue:
                    "Recent active chunks grouped by functional region.",
                })}
              >
                <div className="mb-4 flex flex-wrap gap-2">
                  {REGIONS.map((item) => (
                    <Button
                      key={item}
                      size="sm"
                      variant={region === item ? "default" : "outline"}
                      onClick={() => setRegion(item)}
                    >
                      {item === "all" ? "All" : item}
                    </Button>
                  ))}
                </div>
                <div className="space-y-2">
                  {chunks.length ? (
                    chunks.map((chunk) => (
                      <button
                        type="button"
                        key={chunk.id}
                        onClick={() => void inspect(chunk.id)}
                        className="border-border hover:bg-muted/50 w-full rounded-lg border p-3 text-left transition-colors"
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary">{chunk.region}</Badge>
                            <Badge variant="outline">{chunk.provenance}</Badge>
                          </div>
                          <span className="text-muted-foreground text-xs">
                            {formatDateTime(chunk.updated_at)}
                          </span>
                        </div>
                        <p className="line-clamp-2 text-sm">
                          {chunk.summary || chunk.content}
                        </p>
                        <div className="text-muted-foreground mt-2 text-xs">
                          confidence {scoreLabel(Number(chunk.confidence))} ·
                          importance {scoreLabel(Number(chunk.importance))} ·
                          uses {chunk.access_count}
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
                      No chunks in this region.
                    </div>
                  )}
                </div>
              </SectionPanel>

              <SectionPanel
                title={t("pages.memory.inspect_title", {
                  defaultValue: "Chunk inspector",
                })}
                description={
                  selected
                    ? `${selected.region} · ${selected.provenance}`
                    : t("pages.memory.inspect_empty", {
                        defaultValue:
                          "Select a chunk to inspect provenance and graph links.",
                      })
                }
              >
                {selected ? (
                  <div className="space-y-4">
                    <div className="rounded-lg border p-3 text-sm leading-6">
                      {selected.content}
                    </div>
                    <div className="text-muted-foreground grid grid-cols-2 gap-2 text-xs">
                      <div>
                        Confidence{" "}
                        <strong className="text-foreground">
                          {scoreLabel(Number(selected.confidence))}
                        </strong>
                      </div>
                      <div>
                        Importance{" "}
                        <strong className="text-foreground">
                          {scoreLabel(Number(selected.importance))}
                        </strong>
                      </div>
                      <div>
                        Uses{" "}
                        <strong className="text-foreground">
                          {selected.access_count}
                        </strong>
                      </div>
                      <div>
                        Edges{" "}
                        <strong className="text-foreground">
                          {selected.edges.length}
                        </strong>
                      </div>
                    </div>
                    <div className="text-muted-foreground text-xs">
                      Created {formatDateTime(selected.created_at)}
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void forget()}
                      disabled={busy !== null}
                    >
                      <IconTrash data-icon="inline-start" />
                      Forget chunk
                    </Button>
                  </div>
                ) : (
                  <div className="text-muted-foreground flex min-h-32 flex-col items-center justify-center gap-2 text-center text-sm">
                    <IconShieldCheck className="size-6" />
                    <span>
                      Memory is scope-fixed and credential values are never
                      shown here.
                    </span>
                  </div>
                )}
              </SectionPanel>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
