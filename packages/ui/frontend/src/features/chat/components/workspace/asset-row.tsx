import {
  IconChartBar,
  IconDotsVertical,
  IconDownload,
  IconExternalLink,
  IconFile,
  IconFileDescription,
  IconFileSpreadsheet,
  IconFileTypeDoc,
  IconTrash,
} from "@tabler/icons-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu"
import { cn } from "@/lib/utils"

import type { WorkspaceAsset, WorkspaceAssetKind } from "./types"

const assetIconMap = {
  chart: IconChartBar,
  csv: IconFileSpreadsheet,
  document: IconFileTypeDoc,
  file: IconFile,
  report: IconFileDescription,
} satisfies Record<WorkspaceAssetKind, typeof IconFile>

const assetToneClass = {
  chart: "bg-secondary/65 text-secondary-foreground",
  csv: "bg-success/10 text-success",
  document: "bg-ring/10 text-foreground",
  file: "bg-muted text-muted-foreground",
  report: "bg-primary/10 text-primary",
} satisfies Record<WorkspaceAssetKind, string>

interface AssetRowProps {
  asset: WorkspaceAsset
  onDelete?: (asset: WorkspaceAsset) => void
}

export function AssetRow({ asset, onDelete }: AssetRowProps) {
  const { t } = useTranslation()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const Icon = assetIconMap[asset.kind]

  return (
    <div className="group/asset border-border/55 bg-background/55 flex min-w-0 items-center gap-2 rounded-md border px-2 py-2">
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md",
          assetToneClass[asset.kind],
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{asset.filename}</div>
        {asset.sourceLabel && (
          <div className="text-muted-foreground truncate text-[11px]">
            {asset.sourceLabel}
          </div>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground opacity-100"
            aria-label={t("chat.assets.actions")}
            title={t("chat.assets.actions")}
          >
            <IconDotsVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem asChild>
            <a href={asset.url} target="_blank" rel="noreferrer">
              <IconExternalLink className="size-4" />
              {t("chat.assets.open")}
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={asset.url} download={asset.filename}>
              <IconDownload className="size-4" />
              {t("chat.assets.download")}
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={!onDelete}
            onSelect={() => setDeleteDialogOpen(true)}
          >
            <IconTrash className="size-4" />
            {t("chat.assets.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat.assets.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat.assets.deleteConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => onDelete?.(asset)}
            >
              {t("chat.assets.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
