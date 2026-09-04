import {
  IconBook,
  IconExternalLink,
  IconGitCommit,
  IconScale,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"

import { getSystemVersionInfo } from "@/api/system"
import { PageHeader } from "@/app/layout/page-header"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card"
import { Separator } from "@/shared/ui/separator"

const README_URL = "https://github.com/miki-ai/agent-miki#readme"
const LICENSE_URL = "https://github.com/miki-ai/agent-miki/blob/main/LICENSE"

export function AboutPage() {
  const { t } = useTranslation()
  const { data: versionInfo } = useQuery({
    queryKey: ["system", "version"],
    queryFn: getSystemVersionInfo,
  })

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("pages.about.title")} />
      <div className="flex-1 overflow-auto p-3 lg:p-6">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6">
          <div className="flex flex-col items-center gap-3 pt-6 text-center">
            <img
              src="/icon.png"
              alt=""
              aria-hidden="true"
              draggable={false}
              className="size-16 rounded-xl border object-cover shadow-sm"
            />
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-semibold">Agent Miki</h1>
              <p className="text-muted-foreground text-sm">
                {t("pages.about.tagline")}
              </p>
            </div>
            {versionInfo && (
              <Badge
                variant="secondary"
                className="gap-1 font-mono text-[11px] font-normal"
              >
                {t("pages.about.version_label")} {versionInfo.version}
              </Badge>
            )}
          </div>

          <Card size="sm">
            <CardHeader>
              <CardTitle>{t("pages.about.build_section_title")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  {t("pages.about.version_label")}
                </span>
                <span className="font-mono">
                  {versionInfo?.version ?? "—"}
                </span>
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <IconGitCommit className="size-3.5" />
                  {t("pages.about.git_commit")}
                </span>
                <span className="max-w-[60%] truncate font-mono">
                  {versionInfo?.git_commit ?? "—"}
                </span>
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  {t("pages.about.build_time")}
                </span>
                <span className="font-mono">
                  {versionInfo?.build_time ?? "—"}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle>{t("pages.about.resources_section_title")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button variant="outline" className="justify-start" asChild>
                <a href={README_URL} target="_blank" rel="noreferrer">
                  <IconBook className="size-4" />
                  {t("pages.about.readme")}
                  <IconExternalLink className="text-muted-foreground ml-auto size-3.5" />
                </a>
              </Button>
              <Button variant="outline" className="justify-start" asChild>
                <a href={LICENSE_URL} target="_blank" rel="noreferrer">
                  <IconScale className="size-4" />
                  {t("pages.about.license")}
                  <IconExternalLink className="text-muted-foreground ml-auto size-3.5" />
                </a>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
