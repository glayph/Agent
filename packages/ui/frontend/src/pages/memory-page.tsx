import {
  IconDatabase,
  IconRefresh,
  IconSearch,
  IconShieldCheck,
  IconTrash,
} from "@tabler/icons-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { useTranslation } from "react-i18next"

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
import { notify } from "@/lib/notify"
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
  const { t } = useTranslation()
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
          <div>{t("pages.memory.score", { defaultValue: "score" })}</div>
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
  const [statsError, setStatsError] = useState<string | null>(null)
  const [chunksError, setChunksError] = useState<string | null>(null)
  const chunksRequestIdRef = useRef(0)
  const error = chunksError ?? statsError

  const loadStats = useCallback(async () => {
    setStatsError(null)
    try {
      const response = await getMemoryStats()
      setStats(response.stats)
    } catch (err) {
      const message = err instanceof Error ? err.message : t("pages.memory.load_error", { defaultValue: "Unable to load memory statistics." })
      setStatsError(message)
      notify.error(message, { id: "memory-page:error:stats" })
    }
  }, [t])

  const load = useCallback(async () => {
    const requestId = ++chunksRequestIdRef.current
    setLoading(true)
    setChunksError(null)
    try {
      const chunksResponse = await listMemoryChunks({
        region: region === "all" ? undefined : region,
        limit: 80,
      })
      if (requestId !== chunksRequestIdRef.current) return
      setChunks(chunksResponse.chunks)
    } catch (err) {
      if (requestId !== chunksRequestIdRef.current) return
      const message =
        err instanceof Error
          ? err.message
          : t("pages.memory.load_error", {
              defaultValue: "Unable to load memory chunks.",
            })
      setChunksError(message)
      notify.error(message, { id: "memory-page:error:load" })
    } finally {
      if (requestId === chunksRequestIdRef.current) setLoading(false)
    }
  }, [region, t])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  useEffect(() => {
    setSelected(null)
    void load()
    return () => { chunksRequestIdRef.current += 1 }
  }, [load])

  const inspect = async (chunkId: string) => {
    try {
      setSelected((await inspectMemoryChunk(chunkId)).chunk)
    } catch (err) {
      notify.error(
        err instanceof Error
          ? err.message
          : t("pages.memory.inspect_failed", { defaultValue: "Unable to inspect this memory chunk." }),
        { id: "memory-page:error:inspect" },
      )
    }
  }

  const submitSearch = async (event: FormEvent) => {
    event.preventDefault()
    if (!query.trim()) return
    setBusy("search")
    setSearchResult(null)
    try {
      setSearchResult(
        await searchMemory(query.trim(), {
          maxSelected: 12,
          maxDepth: 2,
          maxTokens: 1200,
        }),
      )
    } catch (err) {
      notify.error(
        err instanceof Error
          ? err.message
          : t("pages.memory.search_failed", { defaultValue: "Memory search failed." }),
        { id: "memory-page:error:submitSearch" },
      )
    } finally {
      setBusy(null)
    }
  }

  const runReindex = async () => {
    setBusy("reindex")
    try {
      const result = await reindexMemory()
      notify.success(
        t("pages.memory.reindexed_count", {
          count: result.result.reindexed,
          defaultValue: "Reindexed {{count}} chunks.",
        }),
        { id: "memory-page:success:runReindex" },
      )
      await Promise.all([load(), loadStats()])
    } catch (err) {
      notify.error(
        err instanceof Error ? err.message : t("pages.memory.reindex_failed", { defaultValue: "Reindex failed." }),
        { id: "memory-page:error:runReindex" },
      )
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
      notify.success(
        t("pages.memory.forgotten", {
          defaultValue: "Memory chunk forgotten.",
        }), { id: "memory-page:success:pages.memory.forgotten" }
      )
      setSelected(null)
      await Promise.all([load(), loadStats()])
    } catch (err) {
      notify.error(
        err instanceof Error
          ? err.message
          : t("pages.memory.forget_failed", { defaultValue: "Could not forget this memory chunk." }),
        { id: "memory-page:error:forget" },
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex h-full flex-col" data-miki-page="memory">
      <PageHeader title={t("pages.memory.title", { defaultValue: "Memory" })}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void Promise.all([load(), loadStats()])}
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

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" data-miki-page-body="true">
        {statsError && stats && (
          <div
            role="status"
            className="border-amber-500/30 bg-amber-500/5 text-foreground mb-4 rounded-lg border px-3 py-2 text-sm"
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
        ) : statsError && !stats ? (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 flex flex-col items-start gap-3 rounded-xl border p-5 sm:p-6"
          >
            <p className="text-destructive text-sm">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void Promise.all([load(), loadStats()])} disabled={loading}>
              <IconRefresh data-icon="inline-start" />
              {t("pages.memory.retry", { defaultValue: "Try again" })}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Metric
                label={t("pages.memory.metrics.chunks", { defaultValue: "Chunks" })}
                value={stats?.chunks ?? 0}
                detail={t("pages.memory.metrics.chunks_detail", { defaultValue: "Active selective records" })}
              />
              <Metric
                label={t("pages.memory.metrics.postings", { defaultValue: "Postings" })}
                value={stats?.postings ?? 0}
                detail={t("pages.memory.metrics.postings_detail", { defaultValue: "Inverted index entries" })}
              />
              <Metric
                label={t("pages.memory.metrics.edges", { defaultValue: "Graph edges" })}
                value={stats?.edges ?? 0}
                detail={t("pages.memory.metrics.edges_detail", { defaultValue: "Bounded traversal links" })}
              />
              <Metric
                label={t("pages.memory.metrics.retrievals", { defaultValue: "Retrievals" })}
                value={stats?.retrievals ?? 0}
                detail={t("pages.memory.metrics.retrievals_detail", { defaultValue: "Diagnostic traces" })}
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
                  aria-label={t("pages.memory.search_title", {
                    defaultValue: "Memory search",
                  })}
                />
                <Button type="submit" disabled={busy !== null || !query.trim()}>
                  <IconSearch data-icon="inline-start" />
                  {t("pages.memory.search_button", { defaultValue: "Search" })}
                </Button>
              </form>
              {searchResult && (
                <div className="mt-4 space-y-2">
                  <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                    <span>
                      {searchResult.result.stats.selectedCount}{" "}
                      {t("pages.memory.selected", { defaultValue: "selected" })}
                    </span>
                    <span>·</span>
                    <span>
                      {searchResult.result.stats.candidateCount}{" "}
                      {t("pages.memory.candidates", {
                        defaultValue: "candidates",
                      })}
                    </span>
                    <span>·</span>
                    <span>
                      {searchResult.result.stats.tokensUsed}/
                      {searchResult.result.stats.maxTokens}{" "}
                      {t("pages.memory.tokens", { defaultValue: "tokens" })}
                    </span>
                    <span>·</span>
                    <span>
                      {searchResult.result.stats.latencyMs}{" "}
                      {t("pages.memory.milliseconds", { defaultValue: "ms" })}
                    </span>
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
                      {t("pages.memory.no_search_matches", { defaultValue: "No selective matches." })}
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
                <div
                  className="mb-4 flex flex-wrap gap-2"
                  role="group"
                  aria-label={t("pages.memory.region_filter", { defaultValue: "Filter by memory region" })}
                >
                  {REGIONS.map((item) => (
                    <Button
                      key={item}
                      size="sm"
                      variant={region === item ? "default" : "outline"}
                      onClick={() => setRegion(item)}
                      aria-pressed={region === item}
                    >
                      {t(`pages.memory.regions.${item}`, { defaultValue: item.replaceAll("_", " ") })}
                    </Button>
                  ))}
                </div>
                <div className="space-y-2">
                  {chunksError ? (
                    <div role="alert" className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 p-3 text-sm">
                      <p className="text-destructive">{chunksError}</p>
                      <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
                        <IconRefresh data-icon="inline-start" />
                        {t("pages.memory.retry", { defaultValue: "Try again" })}
                      </Button>
                    </div>
                  ) : loading ? (
                    <p className="text-muted-foreground text-sm">{t("pages.memory.loadingChunks", { defaultValue: "Loading memory records…" })}</p>
                  ) : chunks.length ? (
                    chunks.map((chunk) => (
                      <button
                        type="button"
                        key={chunk.id}
                        onClick={() => void inspect(chunk.id)}
                        aria-pressed={selected?.id === chunk.id}
                        className="border-border hover:bg-muted/50 focus-visible:ring-ring/60 w-full rounded-lg border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none aria-pressed:border-primary/60 aria-pressed:bg-primary/5"
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
                        <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs">
                          <span>
                            {t("pages.memory.confidence", {
                              defaultValue: "Confidence",
                            })}{" "}
                            {scoreLabel(Number(chunk.confidence))}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {t("pages.memory.importance", {
                              defaultValue: "Importance",
                            })}{" "}
                            {scoreLabel(Number(chunk.importance))}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{t("pages.memory.uses", { defaultValue: "Uses" })} {chunk.access_count}</span>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
                      {t("pages.memory.no_chunks_region", { defaultValue: "No chunks in this region." })}
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
                        {t("pages.memory.confidence", { defaultValue: "Confidence" })}{" "}
                        <strong className="text-foreground">
                          {scoreLabel(Number(selected.confidence))}
                        </strong>
                      </div>
                      <div>
                        {t("pages.memory.importance", { defaultValue: "Importance" })}{" "}
                        <strong className="text-foreground">
                          {scoreLabel(Number(selected.importance))}
                        </strong>
                      </div>
                      <div>
                        {t("pages.memory.uses", { defaultValue: "Uses" })}{" "}
                        <strong className="text-foreground">
                          {selected.access_count}
                        </strong>
                      </div>
                      <div>
                        {t("pages.memory.edges", { defaultValue: "Edges" })}{" "}
                        <strong className="text-foreground">
                          {selected.edges.length}
                        </strong>
                      </div>
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {t("pages.memory.created", { defaultValue: "Created" })}{" "}
                      {formatDateTime(selected.created_at)}
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void forget()}
                      disabled={busy !== null}
                    >
                      <IconTrash data-icon="inline-start" />
                      {t("pages.memory.forget_chunk", {
                        defaultValue: "Forget chunk",
                      })}
                    </Button>
                  </div>
                ) : (
                  <div className="text-muted-foreground flex min-h-32 flex-col items-center justify-center gap-2 text-center text-sm">
                    <IconShieldCheck className="size-6" />
                    <span>
                      {t("pages.memory.scope_fixed_notice", {
                        defaultValue:
                          "Memory is limited to the active scope. Credential values are never shown here.",
                      })}
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
