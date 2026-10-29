import { IconFolderOpen } from "@tabler/icons-react"
import type { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"

import { inputClass } from "./add-model-field-utils"
import { type AddFormFieldSetter, FormRow, SwitchRow } from "./add-model-fields"
import type { AddForm } from "./add-model-form-state"
import type { ModelFilePickerKind } from "./model-file-picker-dialog"

export function AddModelLocalFields({
  form,
  setForm,
  setField,
  setFilePickerKind,
}: {
  form: AddForm
  setForm: Dispatch<SetStateAction<AddForm>>
  setField: AddFormFieldSetter
  setFilePickerKind: (kind: ModelFilePickerKind | null) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4 pt-1">
      <FormRow
        label={t("models.local.ggufModel", { defaultValue: "GGUF model" })}
      >
        <div className="flex gap-2">
          <Input
            value={form.localModelPath}
            onChange={setField("localModelPath")}
            placeholder="/models/model.Q4_K_M.gguf"
            className={`${inputClass} min-w-0 flex-1 font-mono text-sm`}
            aria-label={t("models.local.ggufModel", {
              defaultValue: "GGUF model",
            })}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-9 shrink-0 rounded-md shadow-none"
            onClick={() => setFilePickerKind("llm")}
            aria-label={t("models.local.browseModels", {
              defaultValue: "Browse models",
            })}
            title={t("models.local.browseModels", {
              defaultValue: "Browse models",
            })}
          >
            <IconFolderOpen className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </FormRow>
      <FormRow
        label={t("models.local.llamaServer", { defaultValue: "llama-server" })}
      >
        <div className="flex gap-2">
          <Input
            value={form.localExecutablePath}
            onChange={setField("localExecutablePath")}
            placeholder="/usr/local/bin/llama-server"
            className={`${inputClass} min-w-0 flex-1 font-mono text-sm`}
            aria-label={t("models.local.llamaServer", {
              defaultValue: "llama-server",
            })}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-9 shrink-0 rounded-md shadow-none"
            onClick={() => setFilePickerKind("executable")}
            aria-label={t("models.local.browseExecutable", {
              defaultValue: "Browse executable",
            })}
            title={t("models.local.browseExecutable", {
              defaultValue: "Browse executable",
            })}
          >
            <IconFolderOpen className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </FormRow>
      <div className="grid grid-cols-3 gap-3">
        <FormRow label={t("models.local.port", { defaultValue: "Port" })}>
          <Input
            value={form.localPort}
            onChange={setField("localPort")}
            placeholder="39200"
            inputMode="numeric"
            className={inputClass}
            aria-label={t("models.local.port", { defaultValue: "Port" })}
          />
        </FormRow>
        <FormRow label={t("models.local.context", { defaultValue: "Context" })}>
          <Input
            value={form.localContextSize}
            onChange={setField("localContextSize")}
            placeholder="4096"
            inputMode="numeric"
            className={inputClass}
            aria-label={t("models.local.context", { defaultValue: "Context" })}
          />
        </FormRow>
        <FormRow
          label={t("models.local.gpuLayers", { defaultValue: "GPU layers" })}
        >
          <Input
            value={form.localGpuLayers}
            onChange={setField("localGpuLayers")}
            placeholder="auto"
            className={inputClass}
            aria-label={t("models.local.gpuLayers", {
              defaultValue: "GPU layers",
            })}
          />
        </FormRow>
      </div>
      <SwitchRow
        label={t("models.local.autoStart", { defaultValue: "Auto-start" })}
        checked={form.localAutoStart}
        onCheckedChange={(checked) =>
          setForm((current) => ({ ...current, localAutoStart: checked }))
        }
      />
    </div>
  )
}
