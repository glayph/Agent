import {
  IconCheck,
  IconExternalLink,
  IconLock,
  IconRefresh,
  IconShieldLock,
  IconTrash,
  IconWorld,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"

import {
  type BrowserConnectionSession,
  type PlatformConnection,
  type PlatformDescriptor,
  type PlatformProvider,
  beginBrowserConnection,
  completeBrowserConnection,
  listConnections,
  listPlatforms,
  markBrowserConnectionOpened,
  revokeConnection,
  validateConnection,
} from "@/api/automations"
import { PageHeader } from "@/app/layout/page-header"
import { cn } from "@/lib/utils"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card"
import { Input } from "@/shared/ui/input"

import {
  AutomationCenterNav,
  AutomationCenterSectionHeader,
} from "./automation-center-nav"

const categoryLabels: Record<PlatformDescriptor["category"], string> = {
  social: "Social platforms",
  messaging: "Messaging platforms",
  developer: "Developer platforms",
  utility: "Utilities",
}

const statusLabels: Record<PlatformConnection["status"], string> = {
  needs_browser: "Browser setup needed",
  awaiting_user: "Waiting for browser",
  needs_validation: "Needs validation",
  connected: "Connected",
  restricted: "Restricted",
  token_expiring: "Token expiring",
  revoked: "Revoked",
  failed: "Failed",
}

function statusClass(status: PlatformConnection["status"]): string {
  if (status === "connected")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  if (status === "revoked" || status === "failed")
    return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
  return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
}

function providerConnection(
  connections: PlatformConnection[],
  provider: PlatformProvider,
): PlatformConnection | undefined {
  return connections.find((connection) => connection.provider === provider)
}

export function PlatformConnectionsPage() {
  const queryClient = useQueryClient()
  const [activeSession, setActiveSession] =
    useState<BrowserConnectionSession | null>(null)
  const [accountLabel, setAccountLabel] = useState("")
  const [externalAccountId, setExternalAccountId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const platformsQuery = useQuery({
    queryKey: ["platforms"],
    queryFn: listPlatforms,
  })
  const connectionsQuery = useQuery({
    queryKey: ["platform-connections"],
    queryFn: () => listConnections(),
    refetchInterval: 15_000,
  })
  const platforms = useMemo(
    () => platformsQuery.data?.platforms ?? [],
    [platformsQuery.data?.platforms],
  )
  const connections = connectionsQuery.data?.connections ?? []
  const grouped = useMemo(
    () =>
      platforms.reduce<Record<string, PlatformDescriptor[]>>(
        (groups, platform) => {
          const key = platform.category
          groups[key] = [...(groups[key] ?? []), platform]
          return groups
        },
        {},
      ),
    [platforms],
  )

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["platforms"] })
    await queryClient.invalidateQueries({ queryKey: ["platform-connections"] })
  }

  const startMutation = useMutation({
    mutationFn: (provider: PlatformProvider) =>
      beginBrowserConnection(provider),
    onSuccess: async ({ session, browser }) => {
      setError(null)
      setNotice(`Browser handoff started for ${session.provider}.`)
      setActiveSession(session)
      setAccountLabel("")
      setExternalAccountId("")
      const popup = window.open(browser.url, "_blank", "noopener,noreferrer")
      if (popup) {
        try {
          const opened = await markBrowserConnectionOpened(session.id)
          setActiveSession(opened.session)
        } catch {
          // The session remains usable even if the opened marker fails.
        }
      }
    },
    onError: (mutationError: Error) => setError(mutationError.message),
  })

  const completeMutation = useMutation({
    mutationFn: () => {
      if (!activeSession)
        throw new Error("No browser connection session is active")
      return completeBrowserConnection(activeSession.id, {
        accountLabel,
        externalAccountId: externalAccountId || undefined,
      })
    },
    onSuccess: async ({ connection }) => {
      setError(null)
      setNotice(
        `${connection.accountLabel} was recorded. Read-only validation is still required.`,
      )
      setActiveSession(null)
      await refresh()
    },
    onError: (mutationError: Error) => setError(mutationError.message),
  })

  const validateMutation = useMutation({
    mutationFn: validateConnection,
    onSuccess: async ({ connection }) => {
      setError(null)
      setNotice(connection.healthMessage)
      await refresh()
    },
    onError: (mutationError: Error) => setError(mutationError.message),
  })

  const revokeMutation = useMutation({
    mutationFn: revokeConnection,
    onSuccess: async () => {
      setError(null)
      setNotice(
        "Connection revoked locally. Revoke provider-side access in the official console when required.",
      )
      await refresh()
    },
    onError: (mutationError: Error) => setError(mutationError.message),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Connections"
        titleExtra={
          <Badge variant="outline">{connections.length} recorded</Badge>
        }
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={connectionsQuery.isFetching}
        >
          <IconRefresh
            className={cn(
              "size-4",
              connectionsQuery.isFetching && "animate-spin",
            )}
          />
          Refresh
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto max-w-7xl space-y-6">
          <AutomationCenterNav />
          <AutomationCenterSectionHeader
            eyebrow="Browser-first connections"
            title="Connect services from your browser"
            description="Miki opens the official provider page, keeps passwords and tokens out of chat, then records only a masked connection reference after you return."
          />

          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="flex gap-3 p-4 text-sm">
              <IconShieldLock className="text-primary mt-0.5 size-5 shrink-0" />
              <div className="space-y-1">
                <p className="font-semibold">Security boundary</p>
                <p className="text-muted-foreground">
                  Never paste passwords, OTPs, private keys, access tokens, or
                  API keys into a normal task message. The browser handoff must
                  stay on the official provider domain, and every external
                  action will require a separate approval step.
                </p>
              </div>
            </CardContent>
          </Card>

          {notice ? (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
              {notice}
            </div>
          ) : null}
          {error ? (
            <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-4 py-3 text-sm">
              {error}
            </div>
          ) : null}

          {activeSession ? (
            <Card className="border-primary/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <IconWorld className="size-5" />
                  Return from browser
                </CardTitle>
                <CardDescription>
                  Finish the official provider consent in the browser tab, then
                  record the account label here. Do not enter a token.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
                <label className="space-y-2 text-sm font-medium">
                  Account label
                  <Input
                    value={accountLabel}
                    onChange={(event) => setAccountLabel(event.target.value)}
                    placeholder="e.g. Miki Research Page"
                  />
                </label>
                <label className="space-y-2 text-sm font-medium">
                  Optional provider account ID
                  <Input
                    value={externalAccountId}
                    onChange={(event) =>
                      setExternalAccountId(event.target.value)
                    }
                    placeholder="Page, channel, workspace, or bot ID"
                  />
                </label>
                <div className="flex gap-2">
                  <Button
                    onClick={() => completeMutation.mutate()}
                    disabled={
                      !accountLabel.trim() || completeMutation.isPending
                    }
                  >
                    <IconCheck className="size-4" />
                    Save connection
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setActiveSession(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </CardContent>
              <CardContent className="text-muted-foreground pt-0 text-xs">
                Session expires{" "}
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(activeSession.expiresAt))}
                . Requested scopes:{" "}
                {activeSession.requestedScopes.join(", ") ||
                  "provider defaults"}
                .
              </CardContent>
            </Card>
          ) : null}

          {Object.entries(grouped).map(([category, entries]) => (
            <section key={category} className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">
                  {categoryLabels[category as PlatformDescriptor["category"]] ??
                    category}
                </h2>
                <span className="text-muted-foreground text-xs">
                  {entries.length} providers
                </span>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {entries.map((platform) => {
                  const connection = providerConnection(
                    connections,
                    platform.id,
                  )
                  return (
                    <Card key={platform.id} className="flex flex-col">
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <CardTitle className="text-base">
                              {platform.label}
                            </CardTitle>
                            <CardDescription className="mt-1">
                              {platform.connectionMode === "oauth"
                                ? "Official OAuth"
                                : "Browser-assisted setup"}
                            </CardDescription>
                          </div>
                          <Badge
                            variant="outline"
                            className={
                              connection
                                ? statusClass(connection.status)
                                : "text-muted-foreground"
                            }
                          >
                            {connection
                              ? statusLabels[connection.status]
                              : "Not connected"}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="flex flex-1 flex-col gap-4">
                        <div className="space-y-2 text-sm">
                          <p className="font-medium">Capabilities</p>
                          {platform.capabilities.map((capability) => (
                            <div
                              key={capability.id}
                              className="text-muted-foreground flex items-center justify-between gap-2"
                            >
                              <span>{capability.label}</span>
                              <span className="text-xs">
                                {capability.available
                                  ? "Available"
                                  : "Adapter pending"}
                              </span>
                            </div>
                          ))}
                        </div>
                        <p className="text-muted-foreground text-xs">
                          {platform.capabilities[0]?.notes}
                        </p>
                        {connection ? (
                          <div className="bg-muted/50 rounded-md p-3 text-xs">
                            <p className="font-medium">
                              {connection.accountLabel}
                            </p>
                            <p className="text-muted-foreground mt-1">
                              {connection.healthMessage}
                            </p>
                          </div>
                        ) : null}
                        <div className="mt-auto flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            onClick={() => startMutation.mutate(platform.id)}
                            disabled={
                              startMutation.isPending ||
                              platform.implementation === "ready"
                            }
                          >
                            <IconExternalLink className="size-4" />
                            Open official setup
                          </Button>
                          {connection ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  validateMutation.mutate(connection.id)
                                }
                                disabled={validateMutation.isPending}
                              >
                                <IconLock className="size-4" />
                                Validate
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  revokeMutation.mutate(connection.id)
                                }
                                disabled={revokeMutation.isPending}
                                aria-label={`Revoke ${platform.label}`}
                              >
                                <IconTrash className="size-4" />
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
