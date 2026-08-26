import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import type { WebSearchConfigResponse } from "@/api/tools"
import { Input } from "@/shared/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select"
import { Switch } from "@/shared/ui/switch"

import type { WebSearchDraftUpdater } from "./types"

interface WebSearchGeneralSettingsProps {
  draft: WebSearchConfigResponse
  onUpdateDraft: WebSearchDraftUpdater
}

export function WebSearchGeneralSettings({
  draft,
  onUpdateDraft,
}: WebSearchGeneralSettingsProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-4">
      <h3 className="text-foreground/80 text-[13px] font-bold tracking-widest uppercase">
        {t("pages.agent.tools.web_search.global_settings", "General")}
      </h3>

      <div className="bg-card border-border/40 divide-border/40 divide-y overflow-hidden rounded-2xl border shadow-sm">
        <SettingRow
          label={t(
            "pages.agent.tools.web_search.execution_mode",
            "Execution Mode",
          )}
          description={t(
            "pages.agent.tools.web_search.execution_mode_description",
            "Local is the default and performs retrieval from this Miki host. API uses an enabled web-search API provider. Auto tries local first and falls back to API only when allowed.",
          )}
        >
          <Select
            value={draft.execution_mode ?? "local"}
            onValueChange={(value) =>
              onUpdateDraft((current) => ({
                ...current,
                execution_mode:
                  value === "cloud" || value === "auto" ? value : "local",
              }))
            }
          >
            <SelectTrigger className="bg-muted/40 hover:bg-muted/60 focus:ring-foreground/5 focus:border-border/80 w-full rounded-xl border-transparent shadow-none transition-[background-color,border-color,box-shadow] sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-border/40 rounded-xl shadow-lg">
              <SelectItem value="local" className="rounded-lg">
                {t(
                  "pages.agent.tools.web_search.execution_local",
                  "Local (default)",
                )}
              </SelectItem>
              <SelectItem value="cloud" className="rounded-lg">
                {t(
                  "pages.agent.tools.web_search.execution_cloud",
                  "API / Cloud (explicit)",
                )}
              </SelectItem>
              <SelectItem value="auto" className="rounded-lg">
                {t(
                  "pages.agent.tools.web_search.execution_auto",
                  "Auto (local then API)",
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        {(draft.execution_mode ?? "local") !== "local" && (
          <div className="bg-amber-500/10 px-5 py-3 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
            {t(
              "pages.agent.tools.web_search.execution_privacy_warning",
              "Privacy note: Cloud or Auto may send non-sensitive public queries to a remote provider. Sensitive queries remain blocked from cloud fallback unless explicitly authorized by policy.",
            )}
          </div>
        )}

        <SettingRow
          label={t("pages.agent.tools.web_search.provider", "Primary Provider")}
          description={t(
            "pages.agent.tools.web_search.provider_description",
            "Select the default provider to use when the web search tool handles a request.",
          )}
        >
          <Select
            value={draft.provider}
            onValueChange={(value) =>
              onUpdateDraft((current) => ({
                ...current,
                provider: value,
              }))
            }
          >
            <SelectTrigger className="bg-muted/40 hover:bg-muted/60 focus:ring-foreground/5 focus:border-border/80 w-full rounded-xl border-transparent shadow-none transition-[background-color,border-color,box-shadow] sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-border/40 rounded-xl shadow-lg">
              {draft.providers.map((provider) => (
                <SelectItem
                  key={provider.id}
                  value={provider.id}
                  className="rounded-lg"
                >
                  {provider.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label={t("pages.agent.tools.web_search.proxy", "Proxy Configuration")}
          description={t(
            "pages.agent.tools.web_search.proxy_description",
            "Optional global HTTP/S proxy for underlying web requests.",
          )}
        >
          <Input
            className="bg-muted/40 hover:bg-muted/60 focus-visible:bg-background focus-visible:border-border/80 focus-visible:ring-foreground/5 w-full rounded-xl border-transparent shadow-none transition-[background-color,border-color,box-shadow] duration-300 sm:w-64"
            value={draft.proxy ?? ""}
            onChange={(event) =>
              onUpdateDraft((current) => ({
                ...current,
                proxy: event.target.value,
              }))
            }
            placeholder="http://127.0.0.1:7890"
          />
        </SettingRow>

        <SettingRow
          label={t(
            "pages.agent.tools.web_search.prefer_native",
            "Prefer Native Search",
          )}
          description={t(
            "pages.agent.tools.web_search.prefer_native_hint",
            "When enabled, the model may use its built-in search capability instead of the configured provider list.",
          )}
        >
          <Switch
            checked={draft.prefer_native}
            onCheckedChange={(checked) =>
              onUpdateDraft((current) => ({
                ...current,
                prefer_native: checked,
              }))
            }
            aria-label={t(
              "pages.agent.tools.web_search.prefer_native",
              "Prefer Native Search",
            )}
            className="data-[state=checked]:shadow-xs"
          />
        </SettingRow>

        <div className="bg-muted/20 text-muted-foreground border-border/20 border-t px-5 py-3 text-xs font-semibold tracking-wide uppercase">
          {t(
            "pages.agent.tools.web_search.performance_title",
            "Local Search Performance",
          )}
        </div>

        <SettingRow
          label={t(
            "pages.agent.tools.web_search.cache_enabled",
            "Reuse Recent Results",
          )}
          description={t(
            "pages.agent.tools.web_search.cache_enabled_hint",
            "Caches non-sensitive search results briefly so repeated questions avoid another network request.",
          )}
        >
          <Switch
            checked={draft.optimization?.cache_enabled ?? true}
            onCheckedChange={(checked) =>
              onUpdateDraft((current) => ({
                ...current,
                optimization: {
                  ...current.optimization,
                  cache_enabled: checked,
                },
              }))
            }
            aria-label={t(
              "pages.agent.tools.web_search.cache_enabled",
              "Reuse Recent Results",
            )}
            className="data-[state=checked]:shadow-xs"
          />
        </SettingRow>

        <SettingRow
          label={t(
            "pages.agent.tools.web_search.cache_ttl",
            "Cache Lifetime (minutes)",
          )}
          description={t(
            "pages.agent.tools.web_search.cache_ttl_hint",
            "Use 0 to disable caching; current/news queries should use a short lifetime.",
          )}
        >
          <Input
            type="number"
            min={0}
            max={1440}
            value={Math.round(
              (draft.optimization?.cache_ttl_ms ?? 300000) / 60000,
            )}
            onChange={(event) =>
              onUpdateDraft((current) => ({
                ...current,
                optimization: {
                  ...current.optimization,
                  cache_ttl_ms: Math.max(
                    0,
                    Math.min(
                      86400000,
                      (Number(event.target.value) || 0) * 60000,
                    ),
                  ),
                },
              }))
            }
            className="bg-muted/40 hover:bg-muted/60 focus-visible:bg-background focus-visible:border-border/80 focus-visible:ring-foreground/5 w-full rounded-xl border-transparent shadow-none transition-[background-color,border-color,box-shadow] duration-300 sm:w-32"
          />
        </SettingRow>

        <SettingRow
          label={t(
            "pages.agent.tools.web_search.snippet_chars",
            "Snippet Character Limit",
          )}
          description={t(
            "pages.agent.tools.web_search.snippet_chars_hint",
            "Shorter snippets reduce local-model context usage while keeping source citations.",
          )}
        >
          <Input
            type="number"
            min={120}
            max={1000}
            value={draft.optimization?.snippet_chars ?? 420}
            onChange={(event) =>
              onUpdateDraft((current) => ({
                ...current,
                optimization: {
                  ...current.optimization,
                  snippet_chars: Math.max(
                    120,
                    Math.min(1000, Number(event.target.value) || 120),
                  ),
                },
              }))
            }
            className="bg-muted/40 hover:bg-muted/60 focus-visible:bg-background focus-visible:border-border/80 focus-visible:ring-foreground/5 w-full rounded-xl border-transparent shadow-none transition-[background-color,border-color,box-shadow] duration-300 sm:w-32"
          />
        </SettingRow>
      </div>
    </div>
  )
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="hover:bg-muted/10 flex flex-col justify-between gap-4 p-5 transition-colors sm:flex-row sm:items-center">
      <div className="w-full space-y-1 sm:max-w-md">
        <label className="text-foreground/90 text-[15px] font-semibold tracking-tight">
          {label}
        </label>
        <p className="text-muted-foreground/80 text-[13px] leading-relaxed">
          {description}
        </p>
      </div>
      {children}
    </div>
  )
}
