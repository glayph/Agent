import {
  IconLoader2,
  IconPlugConnected,
  IconRobot,
  IconX,
} from "@tabler/icons-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import {
  type ModelInfo,
  type TestModelInlineRequest,
  testModel,
  testModelInline,
  testModelTools,
  testModelToolsInline,
} from "@/api/models"
import { Button } from "@/shared/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog"

export interface TestInlineParams {
  provider: string
  model: string
  apiBase: string
  apiKey: string
  authMethod: string
  modelIndex?: number
}

interface TestModelDialogProps {
  model: ModelInfo | null
  open: boolean
  onClose: () => void
  inlineParams?: TestInlineParams
}

interface TestResult {
  success: boolean
  latency_ms: number
  status: string
  readiness_status?: string
  verification_level?: "catalog" | "runtime_ready" | "completion" | "tools"
  completion_tested?: boolean
  tools_tested?: boolean
  dry_run_executed?: boolean
  final_response_received?: boolean
  tool_name?: string
  provider?: string
  model?: string
  correlation_id?: string
  error?: string
}

export function TestModelDialog({
  model,
  open,
  onClose,
  inlineParams,
}: TestModelDialogProps) {
  const { t } = useTranslation()
  const [testing, setTesting] = useState(false)
  const [testKind, setTestKind] = useState<"connection" | "agent">("connection")
  const [result, setResult] = useState<TestResult | null>(null)

  const handleTest = async (kind: "connection" | "agent" = "connection") => {
    setTestKind(kind)
    setTesting(true)
    setResult(null)
    try {
      let res: TestResult
      if (inlineParams) {
        const req: TestModelInlineRequest = {
          provider: inlineParams.provider,
          model: inlineParams.model,
          api_base: inlineParams.apiBase || undefined,
          api_key: inlineParams.apiKey || undefined,
          auth_method: inlineParams.authMethod || undefined,
          model_index: inlineParams.modelIndex,
        }
        res =
          kind === "agent"
            ? await testModelToolsInline(req)
            : await testModelInline(req)
      } else if (model) {
        res =
          kind === "agent"
            ? await testModelTools(model.index)
            : await testModel(model.index)
      } else {
        return
      }
      setResult(res)
    } catch (e) {
      setResult({
        success: false,
        latency_ms: 0,
        status: "error",
        error: e instanceof Error ? e.message : t("models.test.testFailed"),
      })
    } finally {
      setTesting(false)
    }
  }

  const handleClose = () => {
    setResult(null)
    onClose()
  }

  // Display info: prefer inline params, fall back to saved model
  const displayModelName = inlineParams?.model || model?.model_name || ""
  const displayModel = inlineParams?.model || model?.model || ""
  const displayApiBase = inlineParams?.apiBase || model?.api_base || ""
  const canTest = !!(inlineParams || model)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconPlugConnected className="size-5" />
            {t("models.test.title")}
          </DialogTitle>
          <DialogDescription>{t("models.test.description")}</DialogDescription>
        </DialogHeader>

        {canTest && (
          <div className="space-y-3">
            <div className="bg-muted/50 rounded-lg p-3 text-sm">
              <div>
                <span className="text-muted-foreground">
                  {t("models.test.modelLabel")}{" "}
                </span>
                <span className="font-mono">{displayModelName}</span>
              </div>
              <div>
                <span className="text-muted-foreground">
                  {t("models.test.identifierLabel")}{" "}
                </span>
                <span className="font-mono">{displayModel}</span>
              </div>
              {displayApiBase && (
                <div>
                  <span className="text-muted-foreground">
                    {t("models.test.endpointLabel")}{" "}
                  </span>
                  <span className="font-mono text-xs">{displayApiBase}</span>
                </div>
              )}
            </div>

            {!result && !testing && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Button onClick={() => handleTest("connection")}>
                  <IconPlugConnected className="size-4" />
                  {t("models.test.testConnection")}
                </Button>
                <Button variant="outline" onClick={() => handleTest("agent")}>
                  <IconRobot className="size-4" />
                  {t("models.test.testAgentReadiness")}
                </Button>
              </div>
            )}

            {testing && (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6">
                <IconLoader2 className="size-5 animate-spin" />
                <span>{t("models.test.testing")}</span>
              </div>
            )}

            {result && (
              <div
                className={`rounded-lg p-4 text-sm ${
                  result.success
                    ? "bg-green-500/10 text-green-700 dark:text-green-400"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {result.success ? (
                  <div className="space-y-1">
                    <div className="font-medium">
                      {t("models.test.success")}
                    </div>
                    <div className="text-xs opacity-80">
                      {t("models.test.responseTime", { ms: result.latency_ms })}
                    </div>
                    {result.verification_level && (
                      <div className="text-xs opacity-80">
                        {t("models.test.verificationLevel", {
                          level: result.verification_level,
                        })}
                      </div>
                    )}
                    {result.readiness_status && (
                      <div className="text-xs opacity-80">
                        {t("models.test.readinessStatus", {
                          status: result.readiness_status,
                        })}
                      </div>
                    )}
                    {result.provider && result.model && (
                      <div className="font-mono text-xs opacity-80">
                        {result.provider}/{result.model}
                      </div>
                    )}
                    {result.correlation_id && (
                      <div className="font-mono text-xs opacity-60">
                        {t("models.test.correlationId", {
                          id: result.correlation_id,
                        })}
                      </div>
                    )}
                    {result.tools_tested && (
                      <div className="text-xs opacity-80">
                        {t("models.test.toolDryRun", {
                          executed: result.dry_run_executed ? "yes" : "no",
                        })}
                      </div>
                    )}
                    {result.completion_tested === false && (
                      <div className="text-xs opacity-80">
                        {t("models.test.completionNotTested")}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1 font-medium">
                      <IconX className="size-4" />
                      {t("models.test.failed")}
                    </div>
                    <div className="text-xs opacity-80">
                      {result.error ||
                        t("models.test.status", { status: result.status })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose}>
            {t("common.cancel")}
          </Button>
          {result && (
            <Button variant="outline" onClick={() => handleTest(testKind)}>
              {testKind === "agent"
                ? t("models.test.testAgentAgain")
                : t("models.test.testAgain")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
