import type { KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"

import type { ToolsPageTab } from "./types"

interface ToolsTabsProps {
  activeTab: ToolsPageTab
  onChange: (tab: ToolsPageTab) => void
}

const tabs: Array<{
  defaultLabel: string
  key: ToolsPageTab
  translationKey: string
}> = [
  {
    key: "library",
    translationKey: "pages.agent.tools.library_title",
    defaultLabel: "Tool Library",
  },
  {
    key: "web-search",
    translationKey: "pages.agent.tools.web_search.title",
    defaultLabel: "Web Search",
  },
]

export function ToolsTabs({ activeTab, onChange }: ToolsTabsProps) {
  const { t } = useTranslation()

  const focusTab = (tab: ToolsPageTab) => {
    document.getElementById(`tools-tab-${tab}`)?.focus()
    onChange(tab)
  }

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault()
        focusTab(tabs[(index + 1) % tabs.length].key)
        break
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault()
        focusTab(tabs[(index - 1 + tabs.length) % tabs.length].key)
        break
      case "Home":
        event.preventDefault()
        focusTab(tabs[0].key)
        break
      case "End":
        event.preventDefault()
        focusTab(tabs[tabs.length - 1].key)
        break
    }
  }

  return (
    <div className="border-border/60 border-b px-6 pt-2">
      <div
        className="flex gap-8"
        role="tablist"
        aria-label={t("pages.agent.tools.tabs", "Tool sections")}
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.key}
            id={`tools-tab-${tab.key}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            aria-controls={`tools-tab-panel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            onClick={() => onChange(tab.key)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              "hover:text-foreground focus-visible:ring-ring/30 relative cursor-pointer rounded-t-md pb-4 text-[14px] font-medium transition-colors outline-none focus-visible:ring-2",
              activeTab === tab.key
                ? "text-foreground"
                : "text-muted-foreground",
            )}
          >
            {t(tab.translationKey, tab.defaultLabel)}
            {activeTab === tab.key && (
              <span className="bg-primary absolute inset-x-0 bottom-0 h-[2px] rounded-t-full" />
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
