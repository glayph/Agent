import {
  IconChevronDown,
  IconChevronRight,
  IconLoader2,
  IconTrash,
} from "@tabler/icons-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  type CatalogEntry,
  type CatalogModel,
  type ModelProviderOption,
  addModel,
  deleteCatalog,
  getCatalogs,
} from "@/api/models"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog"
import { Input } from "@/shared/ui/input"
import { formatDateOnly } from "@/lib/format"
import { refreshGatewayState } from "@/store/gateway"

import {
  getCanonicalProviderKey,
  getProviderCatalogMap,
} from "./provider-registry"

const MODEL_LIST_PAGE_SIZE = 100
const CATALOG_ENTRY_PAGE_SIZE = 20

interface CatalogDialogProps {
  open: boolean
  onClose: () => void
  onModelAdded: () => void
  providerOptions?: ModelProviderOption[]
}

export function CatalogDialog({
  open,
  onClose,
  onModelAdded,
  providerOptions,
}: CatalogDialogProps) {
  const { t } = useTranslation()
  const providerMap = getProviderCatalogMap(providerOptions)
  const [loading, setLoading] = useState(false)
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Map<string, Set<string>>>(new Map())
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<CatalogEntry | null>(null)
  const [modelVisibleCounts, setModelVisibleCounts] = useState<
    Record<string, number>
  >({})
  const [statusMessage, setStatusMessage] = useState<{
    kind: "success" | "error"
    text: string
  } | null>(null)
  const [visibleCatalogCount, setVisibleCatalogCount] = useState(
    CATALOG_ENTRY_PAGE_SIZE,
  )
  const visibleEntries = entries.slice(0, visibleCatalogCount)
  const hiddenCatalogCount = Math.max(0, entries.length - visibleEntries.length)

  const loadCatalogs = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getCatalogs()
      setEntries(res.entries || [])
    } catch (e) {
      const message =
        e instanceof Error ? e.message : t("models.catalog.loadFailed")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (open) {
      loadCatalogs()
      setExpandedId(null)
      setSelected(new Map())
      setFilter("")
      setModelVisibleCounts({})
      setStatusMessage(null)
      setVisibleCatalogCount(CATALOG_ENTRY_PAGE_SIZE)
    }
  }, [open, loadCatalogs])

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  const toggleModel = (catalogId: string, modelId: string) => {
    setSelected((prev) => {
      const next = new Map(prev)
      const set = new Set(next.get(catalogId) || [])
      if (set.has(modelId)) set.delete(modelId)
      else set.add(modelId)
      next.set(catalogId, set)
      return next
    })
  }

  const toggleAll = (catalogId: string, models: CatalogModel[]) => {
    setSelected((prev) => {
      const next = new Map(prev)
      const current = next.get(catalogId) || new Set()
      const filtered = filter
        ? models.filter((m) =>
            m.id.toLowerCase().includes(filter.toLowerCase()),
          )
        : models
      if (filtered.every((m) => current.has(m.id))) {
        next.set(catalogId, new Set())
      } else {
        next.set(catalogId, new Set(filtered.map((m) => m.id)))
      }
      return next
    })
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteCatalog(id)
      setEntries((prev) => prev.filter((e) => e.id !== id))
      setSelected((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      if (expandedId === id) setExpandedId(null)
      setStatusMessage({
        kind: "success",
        text: t("models.catalog.deleteSuccess"),
      })
    } catch (e) {
      const message =
        e instanceof Error ? e.message : t("models.catalog.deleteFailed")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    }
  }

  const handleAddSelected = async (entry: CatalogEntry) => {
    const catalogSelected = selected.get(entry.id) || new Set()
    if (catalogSelected.size === 0) return

    setAdding(true)
    try {
      const modelsToAdd = entry.models.filter((m) => catalogSelected.has(m.id))
      for (const model of modelsToAdd) {
        await addModel({
          model_name: model.id,
          provider: entry.provider || undefined,
          model: model.id,
          api_base: entry.api_base || undefined,
        })
      }
      await refreshGatewayState({ force: true })
      const message = t("models.catalog.addSuccess", {
        count: modelsToAdd.length,
      })
      setStatusMessage({ kind: "success", text: message })
      toast.success(message)
      onModelAdded()
    } catch (e) {
      const message =
        e instanceof Error ? e.message : t("models.catalog.addFailed")
      setStatusMessage({ kind: "error", text: message })
      toast.error(message)
    } finally {
      setAdding(false)
    }
  }

  const getFilteredModels = (models: CatalogModel[]) =>
    filter
      ? models.filter((m) => m.id.toLowerCase().includes(filter.toLowerCase()))
      : models

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("models.catalog.title")}</DialogTitle>
          <DialogDescription>
            {t("models.catalog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {statusMessage && (
            <div
              className={
                statusMessage.kind === "error"
                  ? "border-border bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm"
                  : "border-border bg-muted/60 text-foreground rounded-lg border px-3 py-2 text-sm"
              }
              role={statusMessage.kind === "error" ? "alert" : "status"}
              aria-live={
                statusMessage.kind === "error" ? "assertive" : "polite"
              }
            >
              {statusMessage.text}
            </div>
          )}
          {loading && (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-8">
              <IconLoader2 className="size-5 animate-spin" />
              <span>{t("models.catalog.loading")}</span>
            </div>
          )}

          {!loading && entries.length === 0 && (
            <div className="text-muted-foreground py-8 text-center text-sm">
              {t("models.catalog.empty")}
            </div>
          )}

          {entries.length > 0 && (
            <Input
              aria-label={t("models.catalog.filterPlaceholder")}
              name="model_catalog_filter"
              autoComplete="off"
              placeholder={t("models.catalog.filterPlaceholder")}
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
                setModelVisibleCounts({})
              }}
              className="h-8"
            />
          )}

          <div className="max-h-[400px] space-y-2 overflow-y-auto">
            {visibleEntries.map((entry) => {
              const isExpanded = expandedId === entry.id
              const entrySelected = selected.get(entry.id) || new Set()
              const filteredModels = getFilteredModels(entry.models)
              const providerKey = getCanonicalProviderKey(
                entry.provider,
                providerOptions,
              )
              const providerDef = providerMap.get(providerKey)
              const panelId = `catalog-models-${entry.id}`
              const visibleModelCount =
                modelVisibleCounts[entry.id] ?? MODEL_LIST_PAGE_SIZE
              const visibleModels = filteredModels.slice(0, visibleModelCount)
              const hiddenModelCount = Math.max(
                0,
                filteredModels.length - visibleModels.length,
              )

              return (
                <div
                  key={entry.id}
                  className="bg-card text-card-foreground rounded-lg border"
                >
                  <div className="hover:bg-accent/50 flex items-center gap-2">
                    <button
                      type="button"
                      className="focus-visible:ring-ring/30 flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left focus-visible:ring-2 focus-visible:outline-none"
                      aria-expanded={isExpanded}
                      aria-controls={panelId}
                      onClick={() => toggleExpand(entry.id)}
                    >
                      {isExpanded ? (
                        <IconChevronDown className="text-muted-foreground size-4 shrink-0" />
                      ) : (
                        <IconChevronRight className="text-muted-foreground size-4 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">
                            {providerDef?.label || providerKey}
                          </span>
                          <span className="text-muted-foreground font-mono text-xs">
                            {entry.api_key_mask}
                          </span>
                        </div>
                        <div className="text-muted-foreground flex items-center gap-2 text-xs">
                          <span>
                            {entry.models.length} {t("models.catalog.models")}
                          </span>
                          {entry.api_base && (
                            <>
                              <span>|</span>
                              <span className="truncate">{entry.api_base}</span>
                            </>
                          )}
                          {entry.fetched_at && (
                            <>
                              <span>|</span>
                              <span>
                                {t("models.catalog.fetchedAt")}{" "}
                                {formatDateOnly(entry.fetched_at)}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </button>
                    <div className="flex items-center gap-1 pr-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive size-7"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteTarget(entry)
                        }}
                        aria-label={t("models.catalog.delete")}
                        title={t("models.catalog.delete")}
                      >
                        <IconTrash className="size-3.5" />
                      </Button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div id={panelId} className="border-t px-3 py-2">
                      <div className="text-muted-foreground mb-1.5 flex items-center justify-between text-xs">
                        <span>
                          {t("models.catalog.found", {
                            count: filteredModels.length,
                          })}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleAll(entry.id, entry.models)}
                          className="text-primary hover:underline"
                        >
                          {filteredModels.every((m) => entrySelected.has(m.id))
                            ? t("models.catalog.deselectAll")
                            : t("models.catalog.selectAll")}
                        </button>
                      </div>
                      <div className="max-h-[200px] space-y-0.5 overflow-y-auto">
                        {visibleModels.map((m) => (
                          <label
                            key={m.id}
                            className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm"
                          >
                            <input
                              type="checkbox"
                              checked={entrySelected.has(m.id)}
                              onChange={() => toggleModel(entry.id, m.id)}
                              className="size-3.5"
                            />
                            <span className="font-mono text-xs">{m.id}</span>
                            {m.owned_by && (
                              <span className="text-muted-foreground ml-auto text-xs">
                                {m.owned_by}
                              </span>
                            )}
                          </label>
                        ))}
                        {hiddenModelCount > 0 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="mt-1 w-full"
                            onClick={() =>
                              setModelVisibleCounts((current) => ({
                                ...current,
                                [entry.id]: Math.min(
                                  filteredModels.length,
                                  visibleModelCount + MODEL_LIST_PAGE_SIZE,
                                ),
                              }))
                            }
                          >
                            {t("common.showMore", { count: hiddenModelCount })}
                          </Button>
                        )}
                      </div>
                      {entrySelected.size > 0 && (
                        <div className="mt-2 space-y-2">
                          {providerDef?.requiresApiKey !== false && (
                            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-400">
                              {t("models.catalog.needApiKey")}
                            </div>
                          )}
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              onClick={() => handleAddSelected(entry)}
                              disabled={adding}
                            >
                              {adding && (
                                <IconLoader2 className="mr-1 size-3 animate-spin" />
                              )}
                              {t("models.catalog.addSelected", {
                                count: entrySelected.size,
                              })}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {hiddenCatalogCount > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() =>
                  setVisibleCatalogCount((current) =>
                    Math.min(entries.length, current + CATALOG_ENTRY_PAGE_SIZE),
                  )
                }
              >
                {t("common.showMore", { count: hiddenCatalogCount })}
              </Button>
            )}
          </div>
        </div>
        <AlertDialog
          open={Boolean(deleteTarget)}
          onOpenChange={(isOpen) => {
            if (!isOpen) setDeleteTarget(null)
          }}
        >
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("models.catalog.deleteTitle", {
                  defaultValue: "Delete catalog?",
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("models.catalog.deleteDescription", {
                  defaultValue:
                    "This provider catalog will be removed from the local model catalog.",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (deleteTarget) void handleDelete(deleteTarget.id)
                  setDeleteTarget(null)
                }}
              >
                {t("models.catalog.delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
