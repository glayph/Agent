import {
  IconDatabase,
  IconInfoCircle,
  IconLoader2,
  IconPlus,
  IconStar,
} from "@tabler/icons-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  type ModelInfo,
  type ModelProviderOption,
  getModels,
  setDefaultModel,
} from "@/api/models"
import { PageHeader } from "@/app/layout/page-header"
import { Button } from "@/shared/ui/button"
import { showSaveSuccessOrRestartToast } from "@/lib/restart-required"
import { refreshGatewayState } from "@/store/gateway"

import { AddModelSheet } from "@/features/models/components/add-model-sheet"
import { CatalogDialog } from "@/features/models/components/catalog-dialog"
import { DeleteModelDialog } from "@/features/models/components/delete-model-dialog"
import { EditModelSheet } from "@/features/models/components/edit-model-sheet"
import { LiteLLMStatusPanel } from "@/features/models/components/litellm-status-panel"
import { buildProviderGroups } from "@/features/models/components/models-page-model"
import { ProviderSection } from "@/features/models/components/provider-section"

export function ModelsPage() {
  const { t } = useTranslation()
  const [models, setModels] = useState<ModelInfo[]>([])
  const [providerOptions, setProviderOptions] = useState<ModelProviderOption[]>(
    [],
  )
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState("")

  const [editingModel, setEditingModel] = useState<ModelInfo | null>(null)
  const [deletingModel, setDeletingModel] = useState<ModelInfo | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [settingDefaultIndex, setSettingDefaultIndex] = useState<number | null>(
    null,
  )
  const fetchModels = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getModels()
      const sorted = [...data.models].sort((a, b) => {
        if (a.is_default && !b.is_default) return -1
        if (!a.is_default && b.is_default) return 1
        if (a.available && !b.available) return -1
        if (!a.available && b.available) return 1
        return a.model_name.localeCompare(b.model_name)
      })
      setModels(sorted)
      setProviderOptions(data.provider_options || [])
      setFetchError("")
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : t("models.loadError"))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  const handleSetDefault = async (model: ModelInfo) => {
    if (model.is_default) return

    setSettingDefaultIndex(model.index)
    try {
      await setDefaultModel(model.model_name)
      await fetchModels()
      const gateway = await refreshGatewayState({ force: true })
      showSaveSuccessOrRestartToast(
        t,
        t("models.defaultChangeSuccess"),
        model.model_name,
        gateway?.restartRequired === true,
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("models.loadError"))
    } finally {
      setSettingDefaultIndex(null)
    }
  }

  const providerGroups = buildProviderGroups(models, providerOptions)

  const defaultModel = models.find((model) => model.is_default)
  const defaultModelUnavailable = defaultModel && !defaultModel.available

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("navigation.models")} titleLevel={1}>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCatalogOpen(true)}
            disabled={providerOptions.length === 0}
            className="max-sm:size-8 max-sm:gap-0 max-sm:rounded-full max-sm:px-0"
            aria-label={t("models.catalog.button")}
            title={t("models.catalog.button")}
          >
            <IconDatabase className="size-4" />
            <span className="max-sm:hidden">{t("models.catalog.button")}</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddOpen(true)}
            disabled={providerOptions.length === 0}
            className="max-sm:size-8 max-sm:gap-0 max-sm:rounded-full max-sm:px-0"
            aria-label={t("models.add.button")}
            title={t("models.add.button")}
          >
            <IconPlus className="size-4" />
            <span className="max-sm:hidden">{t("models.add.button")}</span>
          </Button>
        </div>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="pt-2">
          {!defaultModel && (
            <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <span>{t("models.noDefaultHintPrefix")}</span>
              <IconStar className="size-3.5 shrink-0" />
              <span>{t("models.noDefaultHintSuffix")}</span>
            </div>
          )}
          {defaultModelUnavailable && (
            <div
              className="flex items-center gap-1.5 text-sm text-[var(--warning)]"
              role="status"
            >
              <IconInfoCircle className="size-4 shrink-0" aria-hidden="true" />
              <span>
                {t(
                  "models.defaultUnavailableHint",
                  "The default model is not configured yet. Add credentials before using it in chat.",
                )}
              </span>
            </div>
          )}
          <p className="text-muted-foreground mt-1 text-sm">
            {t("models.description")}
          </p>
          <LiteLLMStatusPanel />
          {!loading && providerOptions.length === 0 && (
            <p className="text-muted-foreground mt-1 text-sm">
              {t("models.providerCatalogUnavailable")}
            </p>
          )}
        </div>

        {loading && (
          <div className="flex items-center justify-center py-20">
            <IconLoader2 className="text-muted-foreground size-6 animate-spin" />
          </div>
        )}

        {fetchError && (
          <div className="bg-destructive/10 rounded-lg px-4 py-3 text-sm">
            <p className="text-destructive">{fetchError}</p>
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void fetchModels()
                }}
              >
                {t("models.retry")}
              </Button>
            </div>
          </div>
        )}

        {!loading && !fetchError && (
          <div className="pb-8">
            {providerGroups.map((providerGroup: ReturnType<typeof buildProviderGroups>[number]) => (
              <ProviderSection
                key={providerGroup.key}
                provider={providerGroup.provider}
                models={providerGroup.models}
                onEdit={setEditingModel}
                onSetDefault={handleSetDefault}
                onDelete={setDeletingModel}
                settingDefaultIndex={settingDefaultIndex}
              />
            ))}
          </div>
        )}
      </div>

      <EditModelSheet
        model={editingModel}
        open={editingModel !== null}
        onClose={() => setEditingModel(null)}
        onSaved={fetchModels}
        providerOptions={providerOptions}
      />

      <AddModelSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={fetchModels}
        existingModelNames={models.map((model) => model.model_name)}
        providerOptions={providerOptions}
      />

      <DeleteModelDialog
        model={deletingModel}
        onClose={() => setDeletingModel(null)}
        onDeleted={fetchModels}
      />

      <CatalogDialog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onModelAdded={fetchModels}
        providerOptions={providerOptions}
      />
    </div>
  )
}
