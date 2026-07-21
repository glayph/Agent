import { IconFiles, IconInfoCircle, IconX } from "@tabler/icons-react"
import { type KeyboardEvent, type ReactNode, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/shared/ui/button"
import { cn } from "@/lib/utils"

import { AssetRow } from "./asset-row"
import type { WorkspaceAsset } from "./types"

type InspectorTab = "assets" | "context"

interface AssetPanelProps {
  assets: WorkspaceAsset[]
  contextPanel: ReactNode
  activeTab?: InspectorTab
  onActiveTabChange?: (tab: InspectorTab) => void
  onClose?: () => void
  onDeleteAsset?: (asset: WorkspaceAsset) => void
}

export function AssetPanel({
  assets,
  contextPanel,
  activeTab: controlledTab,
  onActiveTabChange,
  onClose,
  onDeleteAsset,
}: AssetPanelProps) {
  const { t } = useTranslation()
  const [internalTab, setInternalTab] = useState<InspectorTab>("assets")
  const activeTab = controlledTab ?? internalTab
  const setActiveTab = (tab: InspectorTab) => {
    setInternalTab(tab)
    onActiveTabChange?.(tab)
  }
  const [deletedAssetIds, setDeletedAssetIds] = useState<Set<string>>(
    () => new Set(),
  )
  const visibleAssets = assets.filter((asset) => !deletedAssetIds.has(asset.id))
  const tabs: Array<{
    id: InspectorTab
    label: string
    Icon: typeof IconFiles
  }> = [
    {
      id: "assets",
      label: t("chat.assets.tabs.assets", { defaultValue: "Assets" }),
      Icon: IconFiles,
    },
    {
      id: "context",
      label: t("chat.assets.tabs.context", { defaultValue: "Context" }),
      Icon: IconInfoCircle,
    },
  ]

  const handleDeleteAsset = (asset: WorkspaceAsset) => {
    setDeletedAssetIds((current) => {
      const next = new Set(current)
      next.add(asset.id)
      return next
    })
    onDeleteAsset?.(asset)
  }

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    tabId: InspectorTab,
  ) => {
    const currentIndex = tabs.findIndex((tab) => tab.id === tabId)
    if (currentIndex === -1) {
      return
    }

    const nextTab = (nextIndex: number) => {
      const tab = tabs[(nextIndex + tabs.length) % tabs.length]
      setActiveTab(tab.id)
      window.requestAnimationFrame(() => {
        document.getElementById(`workspace-inspector-${tab.id}-tab`)?.focus()
      })
    }

    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault()
        nextTab(currentIndex + 1)
        break
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault()
        nextTab(currentIndex - 1)
        break
      case "Home":
        event.preventDefault()
        nextTab(0)
        break
      case "End":
        event.preventDefault()
        nextTab(tabs.length - 1)
        break
    }
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col">
      <div className="border-border/65 flex h-14 shrink-0 items-center justify-between gap-2 border-b px-3">
        <div
          role="tablist"
          aria-label={t("chat.assets.inspectorTabs", {
            defaultValue: "Inspector tabs",
          })}
          className="bg-muted/35 flex min-w-0 items-center gap-1 rounded-md p-1"
        >
          {tabs.map((tab) => {
            const Icon = tab.Icon
            const isActive = activeTab === tab.id
            const tabId = `workspace-inspector-${tab.id}-tab`
            const panelId = `workspace-inspector-${tab.id}-panel`

            return (
              <button
                key={tab.id}
                id={tabId}
                type="button"
                role="tab"
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors",
                  isActive
                    ? "bg-card text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-selected={isActive}
                aria-controls={panelId}
                tabIndex={isActive ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
              >
                <Icon className="size-3.5" />
                {tab.label}
              </button>
            )
          })}
        </div>

        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={onClose}
            aria-label={t("chat.assets.closeInspector", {
              defaultValue: "Close inspector",
            })}
            title={t("chat.assets.closeInspector", {
              defaultValue: "Close inspector",
            })}
          >
            <IconX className="size-4" />
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {activeTab === "assets" ? (
          <div
            id="workspace-inspector-assets-panel"
            role="tabpanel"
            aria-labelledby="workspace-inspector-assets-tab"
            className="flex flex-col gap-2"
          >
            {visibleAssets.length > 0 ? (
              visibleAssets.map((asset) => (
                <AssetRow
                  key={asset.id}
                  asset={asset}
                  onDelete={handleDeleteAsset}
                />
              ))
            ) : (
              <div className="border-border/60 bg-background/45 rounded-md border p-4">
                <div className="text-[13px] font-medium">
                  {t("chat.assets.emptyTitle", {
                    defaultValue: "No generated assets",
                  })}
                </div>
                <p className="text-muted-foreground mt-1 text-[12px] leading-5">
                  {t("chat.assets.emptyDescription", {
                    defaultValue:
                      "Reports, CSV files, documents, and charts from agent output will appear here.",
                  })}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div
            id="workspace-inspector-context-panel"
            role="tabpanel"
            aria-labelledby="workspace-inspector-context-tab"
          >
            {contextPanel}
          </div>
        )}
      </div>
    </aside>
  )
}
