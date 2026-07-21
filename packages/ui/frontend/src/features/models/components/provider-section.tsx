import { IconChevronDown } from "@tabler/icons-react"
import { useState } from "react"

import type { ModelInfo } from "@/api/models"

import { ModelCard } from "./model-card"
import { ProviderIcon } from "./provider-icon"
import type { ProviderCatalogEntry } from "./provider-registry"

interface ProviderSectionProps {
  provider: Pick<ProviderCatalogEntry, "key" | "label" | "iconSlug" | "domain">
  models: ModelInfo[]
  onEdit: (model: ModelInfo) => void
  onSetDefault: (model: ModelInfo) => void
  onDelete: (model: ModelInfo) => void
  settingDefaultIndex: number | null
}

export function ProviderSection({
  provider,
  models,
  onEdit,
  onSetDefault,
  onDelete,
  settingDefaultIndex,
}: ProviderSectionProps) {
  const [open, setOpen] = useState(true)

  return (
    <section className="my-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="border-border/60 bg-card/80 hover:bg-muted/35 mb-3 flex min-h-10 w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ProviderIcon provider={provider} />
          <span className="text-foreground truncate text-sm font-semibold">
            {provider.label}
          </span>
          <span className="text-muted-foreground bg-muted/60 shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-none">
            {models.length}
          </span>
        </span>
        <span className="text-muted-foreground flex shrink-0 items-center gap-2">
          <IconChevronDown
            className={[
              "size-4 transition-transform",
              open ? "rotate-180" : "",
            ].join(" ")}
            aria-hidden="true"
          />
        </span>
      </button>

      {open && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {models.map((model) => (
            <ModelCard
              key={model.model_name}
              model={model}
              onEdit={onEdit}
              onSetDefault={onSetDefault}
              onDelete={onDelete}
              settingDefault={settingDefaultIndex === model.index}
            />
          ))}
        </div>
      )}
    </section>
  )
}
