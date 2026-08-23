import {
  IconCheck,
  IconEdit,
  IconLoader2,
  IconMicrophone,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { approveApprovalRequest } from "@/api/control"
import {
  type SpeechModelTransport,
  type SpeechModelsResponse,
  type SpeechToTextModel,
  activateSpeechModel,
  addSpeechModel,
  deleteSpeechModel,
  getSpeechModels,
  healthCheckVoiceModel,
  installVoiceModel,
  updateSpeechModel,
} from "@/api/speech-models"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card"
import { Input } from "@/shared/ui/input"
import { Label } from "@/shared/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select"
import { Switch } from "@/shared/ui/switch"

import {
  ModelFilePickerDialog,
  type ModelFilePickerKind,
} from "./model-file-picker-dialog"

interface SpeechModelForm {
  id: string
  name: string
  transport: SpeechModelTransport
  endpoint: string
  executable: string
  model: string
  enabled: boolean
}

const EMPTY_FORM: SpeechModelForm = {
  id: "",
  name: "",
  transport: "cli",
  endpoint: "",
  executable: "",
  model: "",
  enabled: true,
}

function formFromModel(model: SpeechToTextModel): SpeechModelForm {
  return {
    id: model.id,
    name: model.name,
    transport: model.transport,
    endpoint: model.endpoint || "",
    executable: model.executable || "",
    model: model.model || "",
    enabled: model.enabled,
  }
}

export function SpeechToTextModels() {
  const { t } = useTranslation()
  const [data, setData] = useState<SpeechModelsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [installingModelId, setInstallingModelId] = useState<string | null>(
    null,
  )
  const [pendingInstall, setPendingInstall] = useState<{
    modelId: string
    approvalRequestId: string
    plan: Record<string, unknown>
  } | null>(null)
  const [checkingHealth, setCheckingHealth] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<SpeechModelForm>(EMPTY_FORM)
  const [filePickerKind, setFilePickerKind] =
    useState<ModelFilePickerKind | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await getSpeechModels())
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("models.speech.loadError", "Failed to load speech models"),
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const beginAdd = () => {
    setEditingId("")
    setForm(EMPTY_FORM)
  }

  const beginEdit = (model: SpeechToTextModel) => {
    setEditingId(model.id)
    setForm(formFromModel(model))
  }

  const cancelForm = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  const saveModel = async () => {
    if (!form.id.trim() || !form.name.trim()) {
      toast.error(
        t("models.speech.required", "Model ID and name are required."),
      )
      return
    }
    if (form.transport === "endpoint" && !form.endpoint.trim()) {
      toast.error(
        t("models.speech.endpointRequired", "An HTTP(S) endpoint is required."),
      )
      return
    }
    if (
      form.transport === "cli" &&
      (!form.executable.trim() || !form.model.trim())
    ) {
      toast.error(
        t(
          "models.speech.cliRequired",
          "CLI executable and model paths are required.",
        ),
      )
      return
    }
    setSaving(true)
    try {
      const payload: SpeechToTextModel = {
        id: form.id.trim(),
        name: form.name.trim(),
        transport: form.transport,
        enabled: form.enabled,
        ...(form.transport === "endpoint"
          ? { endpoint: form.endpoint.trim() }
          : { executable: form.executable.trim(), model: form.model.trim() }),
      }
      const response = editingId
        ? await updateSpeechModel(editingId, payload)
        : await addSpeechModel({
            ...payload,
            set_active: data?.models.length === 0,
          })
      setData(response)
      cancelForm()
      toast.success(t("models.speech.saved", "Speech model saved."))
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("models.speech.saveError", "Failed to save speech model"),
      )
    } finally {
      setSaving(false)
    }
  }

  const removeModel = async (model: SpeechToTextModel) => {
    if (
      !window.confirm(
        t("models.speech.deleteConfirm", `Delete "${model.name}"?`),
      )
    )
      return
    try {
      setData(await deleteSpeechModel(model.id))
      toast.success(t("models.speech.deleted", "Speech model deleted."))
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("models.speech.deleteError", "Failed to delete speech model"),
      )
    }
  }

  const selectModel = async (model: SpeechToTextModel) => {
    try {
      setData(await activateSpeechModel(model.id))
      toast.success(t("models.speech.active", "Active speech model updated."))
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("models.speech.activateError", "Failed to activate speech model"),
      )
    }
  }

  const installModel = async (modelId: string) => {
    setInstallingModelId(modelId)
    try {
      const response = await installVoiceModel(modelId)
      if (
        response.status === "approval_required" &&
        response.approval_request_id &&
        response.plan
      ) {
        setPendingInstall({
          modelId,
          approvalRequestId: response.approval_request_id,
          plan: response.plan,
        })
        toast.info(
          t(
            "models.speech.approvalRequired",
            "Owner approval is required before downloading this voice model.",
          ),
        )
        return
      }
      setData(response)
      toast.success(
        t("models.speech.installed", "Voice model installed and verified."),
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("models.speech.installError", "Failed to install voice model"),
      )
    } finally {
      setInstallingModelId(null)
    }
  }

  const approveAndInstallModel = async () => {
    if (!pendingInstall) return
    setInstallingModelId(pendingInstall.modelId)
    try {
      await approveApprovalRequest(pendingInstall.approvalRequestId)
      const response = await installVoiceModel(
        pendingInstall.modelId,
        pendingInstall.approvalRequestId,
        pendingInstall.plan,
      )
      setData(response)
      setPendingInstall(null)
      toast.success(
        t("models.speech.installed", "Voice model installed and verified."),
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("models.speech.installError", "Failed to install voice model"),
      )
    } finally {
      setInstallingModelId(null)
    }
  }

  const checkHealth = async () => {
    setCheckingHealth(true)
    try {
      const response = await healthCheckVoiceModel()
      setData(response)
      toast.success(
        response.local_runtime?.healthy
          ? t("models.speech.healthOk", "Local voice model is ready.")
          : t("models.speech.healthFailed", "Local voice model is not ready."),
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("models.speech.healthError", "Health check failed"),
      )
    } finally {
      setCheckingHealth(false)
    }
  }

  return (
    <section className="my-6">
      <Card className="border-border/60 bg-card/70">
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="flex min-w-0 items-start gap-3">
            <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <IconMicrophone className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-base">
                {t("models.speech.title", "Speech-to-Text Models")}
              </CardTitle>
              <p className="text-muted-foreground mt-1 text-sm">
                {t(
                  "models.speech.description",
                  "Local voice-to-text is optional. Install a model below or configure your own compatible runtime; nothing is downloaded automatically.",
                )}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Label
              htmlFor="speech-enabled"
              className="text-muted-foreground text-xs"
            >
              {data?.local_runtime?.healthy
                ? t("models.speech.on", "On")
                : t("models.speech.off", "Off")}
            </Label>
            <Switch
              id="speech-enabled"
              checked={data?.local_runtime?.healthy === true}
              disabled
              aria-label={t(
                "models.speech.toggle",
                "Local voice model readiness",
              )}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={beginAdd}
              disabled={loading || editingId !== null}
            >
              <IconPlus className="size-4" />
              <span className="hidden sm:inline">
                {t("models.speech.add", "Add audio model")}
              </span>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-muted-foreground flex items-center gap-2 py-4 text-sm">
              <IconLoader2 className="size-4 animate-spin" />
              {t("models.speech.loading", "Loading speech models…")}
            </div>
          ) : data?.models.length ? (
            <div className="grid gap-2">
              {data.models.map((model) => {
                const active = data.active_model_id === model.id
                return (
                  <div
                    key={model.id}
                    className="border-border/60 bg-background/45 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => void selectModel(model)}
                      disabled={model.enabled === false || active}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {model.name}
                        </span>
                        {active && (
                          <Badge variant="secondary">
                            {t("models.speech.activeBadge", "Active")}
                          </Badge>
                        )}
                        {model.enabled === false && (
                          <Badge variant="outline">
                            {t("models.speech.disabledBadge", "Disabled")}
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1 truncate text-xs">
                        {model.transport === "endpoint"
                          ? model.endpoint
                          : model.model}
                      </p>
                    </button>
                    <div className="flex items-center gap-1">
                      {!active && model.enabled !== false && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => void selectModel(model)}
                        >
                          <IconCheck className="size-4" />
                          <span className="sr-only">
                            {t("models.speech.activate", "Activate")}
                          </span>
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => beginEdit(model)}
                        disabled={editingId !== null}
                      >
                        <IconEdit className="size-4" />
                        <span className="sr-only">
                          {t("models.speech.edit", "Edit")}
                        </span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeModel(model)}
                      >
                        <IconTrash className="text-destructive size-4" />
                        <span className="sr-only">
                          {t("models.speech.delete", "Delete")}
                        </span>
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
              {t(
                "models.speech.empty",
                "No speech model configured. Add a whisper.cpp server endpoint or a local CLI + model pair.",
              )}
            </p>
          )}

          {data?.local_runtime && (
            <div className="border-border/60 bg-muted/20 mt-4 rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">
                    {t("models.speech.localStatus", "Local voice model status")}
                  </h3>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {data.local_runtime.reason}
                  </p>
                  {data.local_runtime.activeModelName && (
                    <p className="mt-2 text-xs">
                      {t("models.speech.activeModel", "Active model")}:{" "}
                      {data.local_runtime.activeModelName}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void checkHealth()}
                  disabled={
                    checkingHealth || loading || installingModelId !== null
                  }
                >
                  {checkingHealth && (
                    <IconLoader2 className="size-4 animate-spin" />
                  )}
                  {t("models.speech.healthCheck", "Check health")}
                </Button>
              </div>
              {pendingInstall && (
                <div className="border-primary/30 bg-primary/5 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                  <p className="text-sm">
                    {t(
                      "models.speech.approvalPending",
                      "A verified download is waiting for your approval.",
                    )}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void approveAndInstallModel()}
                      disabled={installingModelId !== null || checkingHealth}
                    >
                      {installingModelId === pendingInstall.modelId && (
                        <IconLoader2 className="size-4 animate-spin" />
                      )}
                      {t("models.speech.approveInstall", "Approve & install")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setPendingInstall(null)}
                      disabled={installingModelId !== null}
                    >
                      {t("models.speech.cancelApproval", "Cancel")}
                    </Button>
                  </div>
                </div>
              )}
              <div className="mt-4 grid gap-2">
                {data.local_runtime.catalog
                  .filter((model) => !model.installed)
                  .map((model) => (
                    <div
                      key={model.id}
                      className="border-border/60 bg-background/45 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {model.name}
                        </p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {model.description} · {model.size} · {model.languages}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void installModel(model.id)}
                        disabled={installingModelId !== null || checkingHealth}
                      >
                        {installingModelId === model.id && (
                          <IconLoader2 className="size-4 animate-spin" />
                        )}
                        {installingModelId === model.id
                          ? t("models.speech.installing", "Installing…")
                          : t("models.speech.install", "Install")}
                      </Button>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {editingId !== null && (
            <div className="border-border/60 bg-muted/20 mt-4 rounded-lg border p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  {editingId
                    ? t("models.speech.editTitle", "Edit speech model")
                    : t("models.speech.addTitle", "Add speech model")}
                </h3>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={cancelForm}
                  aria-label={t("models.speech.cancel", "Cancel")}
                >
                  <IconX className="size-4" />
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="speech-model-id">
                    {t("models.speech.id", "Model ID")}
                  </Label>
                  <Input
                    id="speech-model-id"
                    value={form.id}
                    onChange={(event) =>
                      setForm({ ...form, id: event.target.value })
                    }
                    disabled={Boolean(editingId)}
                    placeholder="whisper-base"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="speech-model-name">
                    {t("models.speech.name", "Display name")}
                  </Label>
                  <Input
                    id="speech-model-name"
                    value={form.name}
                    onChange={(event) =>
                      setForm({ ...form, name: event.target.value })
                    }
                    placeholder="Whisper Base"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="speech-model-transport">
                    {t("models.speech.transport", "Transport")}
                  </Label>
                  <Select
                    value={form.transport}
                    onValueChange={(value: SpeechModelTransport) =>
                      setForm({ ...form, transport: value })
                    }
                  >
                    <SelectTrigger
                      id="speech-model-transport"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cli">
                        {t("models.speech.transportCli", "Local whisper-cli")}
                      </SelectItem>
                      <SelectItem value="endpoint">
                        {t(
                          "models.speech.transportEndpoint",
                          "Whisper server endpoint",
                        )}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 pt-7">
                  <Switch
                    id="speech-model-enabled"
                    checked={form.enabled}
                    onCheckedChange={(enabled) => setForm({ ...form, enabled })}
                  />
                  <Label htmlFor="speech-model-enabled">
                    {t("models.speech.modelEnabled", "Model enabled")}
                  </Label>
                </div>
                {form.transport === "endpoint" ? (
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label htmlFor="speech-model-endpoint">
                      {t("models.speech.endpoint", "Whisper server endpoint")}
                    </Label>
                    <Input
                      id="speech-model-endpoint"
                      value={form.endpoint}
                      onChange={(event) =>
                        setForm({ ...form, endpoint: event.target.value })
                      }
                      placeholder="http://127.0.0.1:8080"
                    />
                  </div>
                ) : (
                  <>
                    <div className="grid gap-1.5 sm:col-span-2">
                      <Label htmlFor="speech-model-executable">
                        {t(
                          "models.speech.executable",
                          "whisper-cli executable path",
                        )}
                      </Label>
                      <div className="flex gap-2">
                        <Input
                          id="speech-model-executable"
                          value={form.executable}
                          onChange={(event) =>
                            setForm({ ...form, executable: event.target.value })
                          }
                          placeholder="/absolute/path/to/whisper-cli"
                          className="min-w-0 flex-1"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setFilePickerKind("executable")}
                        >
                          Explore executable
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-1.5 sm:col-span-2">
                      <Label htmlFor="speech-model-file">
                        {t("models.speech.modelPath", "Whisper model path")}
                      </Label>
                      <div className="flex gap-2">
                        <Input
                          id="speech-model-file"
                          value={form.model}
                          onChange={(event) =>
                            setForm({ ...form, model: event.target.value })
                          }
                          placeholder="/absolute/path/to/ggml-base.bin"
                          className="min-w-0 flex-1"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setFilePickerKind("whisper")}
                        >
                          Explore models
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={cancelForm}>
                  {t("models.speech.cancel", "Cancel")}
                </Button>
                <Button
                  type="button"
                  onClick={() => void saveModel()}
                  disabled={saving}
                >
                  {saving && <IconLoader2 className="size-4 animate-spin" />}
                  {t("models.speech.save", "Save speech model")}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <ModelFilePickerDialog
        open={filePickerKind !== null}
        onOpenChange={(open) => !open && setFilePickerKind(null)}
        kind={filePickerKind ?? "whisper"}
        onSelect={(path) => {
          if (filePickerKind === "whisper") {
            setForm((current) => ({ ...current, model: path }))
          } else if (filePickerKind === "executable") {
            setForm((current) => ({ ...current, executable: path }))
          }
          setFilePickerKind(null)
        }}
      />
    </section>
  )
}
