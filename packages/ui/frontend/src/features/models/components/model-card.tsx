import {
  IconEdit,
  IconKey,
  IconLoader2,
  IconStar,
  IconStarFilled,
  IconTrash,
} from "@tabler/icons-react"
import { useTranslation } from "react-i18next"

import type { ModelInfo } from "@/api/models"
import { Button } from "@/shared/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/ui/tooltip"

interface ModelCardProps {
  model: ModelInfo
  onEdit: (model: ModelInfo) => void
  onSetDefault: (model: ModelInfo) => void
  onDelete: (model: ModelInfo) => void
  settingDefault: boolean
}

export function ModelCard({
  model,
  onEdit,
  onSetDefault,
  onDelete,
  settingDefault,
}: ModelCardProps) {
  const { t } = useTranslation()
  const isOAuth = model.auth_method === "oauth"
  const status = model.status
  const statusLabel = t(`models.status.${status}`)
  const canSetDefault =
    model.available &&
    !model.is_default &&
    !model.is_virtual &&
    model.default_model_allowed !== false
  const setDefaultBlocked = !canSetDefault || settingDefault

  const setDefaultLabel = t("models.action.setDefault")
  const setDefaultDisabledReason = (() => {
    if (settingDefault) return t("models.action.setDefaultDisabled.setting")
    if (!model.available)
      return t("models.action.setDefaultDisabled.unavailable")
    if (model.is_default) return t("models.action.setDefaultDisabled.isDefault")
    if (model.is_virtual) return t("models.action.setDefaultDisabled.isVirtual")
    if (model.default_model_allowed === false) {
      return t("models.action.setDefaultDisabled.unsupportedProvider")
    }
    return setDefaultLabel
  })()

  const editLabel = t("models.action.edit")
  const deleteLabel = t("models.action.delete")
  const deleteDisabledReason = model.is_default
    ? t("models.action.deleteDisabled.isDefault")
    : deleteLabel
  const deleteDisabled = model.is_default
  const statusDotClass = (() => {
    if (model.is_default && model.available) {
      return "bg-green-400 shadow-[0_0_0_2px_rgba(74,222,128,0.35)]"
    }
    if (model.is_default) {
      return "bg-amber-500 shadow-[0_0_0_2px_rgba(245,158,11,0.25)]"
    }
    if (status === "available") return "bg-green-500"
    if (status === "unreachable") return "bg-amber-500"
    return "bg-muted-foreground/25"
  })()

  return (
    <div
      className={[
        "group/card hover:bg-muted/30 relative flex w-full max-w-[36rem] flex-col gap-3 justify-self-start rounded-xl border p-4 transition-colors hover:shadow-xs",
        model.available
          ? "border-border/60 bg-card"
          : "border-border/50 bg-card/90",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={[
              "mt-0.5 h-2 w-2 shrink-0 rounded-full",
              statusDotClass,
            ].join(" ")}
            title={statusLabel}
          />
          <span className="text-foreground truncate text-sm font-semibold">
            {model.model_name}
          </span>
          {model.is_default && (
            <span className="bg-primary/10 text-primary shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium">
              {t("models.badge.default")}
            </span>
          )}
          {model.is_virtual && (
            <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium">
              {t("models.badge.virtual")}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {model.is_default ? (
            <span
              className="text-primary p-1"
              title={t("models.badge.default")}
              aria-label={t("models.badge.default")}
            >
              <IconStarFilled className="size-3.5" aria-hidden="true" />
            </span>
          ) : (
            <Tooltip delayDuration={!canSetDefault || settingDefault ? 0 : 700}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    if (!setDefaultBlocked) onSetDefault(model)
                  }}
                  disabled={settingDefault}
                  aria-disabled={setDefaultBlocked ? true : undefined}
                  aria-label={setDefaultLabel}
                  title={setDefaultLabel}
                  className={
                    setDefaultBlocked
                      ? "text-muted-foreground/45 hover:text-muted-foreground/45 cursor-not-allowed hover:bg-transparent"
                      : undefined
                  }
                >
                  {settingDefault ? (
                    <IconLoader2
                      className="size-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <IconStar className="size-3.5" aria-hidden="true" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{setDefaultDisabledReason}</TooltipContent>
            </Tooltip>
          )}

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onEdit(model)}
            aria-label={editLabel}
            title={editLabel}
          >
            <IconEdit className="size-3.5" aria-hidden="true" />
          </Button>

          <Tooltip delayDuration={deleteDisabled ? 0 : 700}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  if (!deleteDisabled) onDelete(model)
                }}
                aria-disabled={deleteDisabled ? true : undefined}
                aria-label={deleteLabel}
                title={deleteLabel}
                className={[
                  "text-muted-foreground hover:text-destructive hover:bg-destructive/10",
                  deleteDisabled
                    ? "hover:text-muted-foreground/45 cursor-not-allowed hover:bg-transparent"
                    : "",
                ].join(" ")}
              >
                <IconTrash className="size-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{deleteDisabledReason}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <p className="text-muted-foreground truncate font-mono text-xs leading-snug">
        {model.model}
      </p>

      <div className="flex items-center gap-2">
        {isOAuth ? (
          <span className="text-muted-foreground bg-muted rounded px-1.5 py-0.5 text-[10px] font-medium">
            OAuth
          </span>
        ) : status === "available" && model.api_key ? (
          <span className="text-muted-foreground/70 flex items-center gap-1 font-mono text-[11px]">
            <IconKey className="size-3" aria-hidden="true" />
            {model.api_key}
          </span>
        ) : (
          <span className="text-muted-foreground/50 text-[11px]">
            {statusLabel}
          </span>
        )}
      </div>
    </div>
  )
}
