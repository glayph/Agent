import { useTranslation } from "react-i18next"

import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { useIncrementalList } from "@/hooks/use-incremental-list"

const DEFAULT_MODEL_SUGGESTION_PAGE_SIZE = 48

interface ModelSuggestionBadgesProps {
  models: string[]
  selectedModel: string
  onSelect: (model: string) => void
  pageSize?: number
}

export function ModelSuggestionBadges({
  models,
  selectedModel,
  onSelect,
  pageSize = DEFAULT_MODEL_SUGGESTION_PAGE_SIZE,
}: ModelSuggestionBadgesProps) {
  const { t } = useTranslation()
  const { hiddenCount, showMore, visibleItems } = useIncrementalList({
    items: models,
    initialCount: pageSize,
    step: pageSize,
    resetKey: `${models.length}:${models[0] ?? ""}:${models.at(-1) ?? ""}`,
  })

  if (models.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleItems.map((model) => (
        <Badge
          key={model}
          variant={selectedModel === model ? "default" : "outline"}
          className="cursor-pointer font-mono text-xs"
          asChild
        >
          <button type="button" onClick={() => onSelect(model)}>
            {model}
          </button>
        </Badge>
      ))}
      {hiddenCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={showMore}
        >
          {t("common.showMore", { count: hiddenCount })}
        </Button>
      )}
    </div>
  )
}
