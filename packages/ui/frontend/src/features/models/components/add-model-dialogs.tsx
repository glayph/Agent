import type { Dispatch, SetStateAction } from "react"

import type { ModelProviderOption } from "@/api/models"

import type { AddForm } from "./add-model-form-state"
import { FetchModelsDialog } from "./fetch-models-dialog"
import {
  ModelFilePickerDialog,
  type ModelFilePickerKind,
} from "./model-file-picker-dialog"
import { TestModelDialog } from "./test-model-dialog"

interface AddModelDialogsProps {
  provider: string
  form: AddForm
  setForm: Dispatch<SetStateAction<AddForm>>
  apiBase: string
  authMethod: string
  providerOptions?: ModelProviderOption[]
  alreadyAddedModelIds: string[]
  fetchOpen: boolean
  onFetchClose: () => void
  onFetchFill: (models: string[]) => void
  testOpen: boolean
  onTestClose: () => void
  filePickerKind: ModelFilePickerKind | null
  onFilePickerKindChange: (kind: ModelFilePickerKind | null) => void
}

/** Secondary dialogs opened from the Add Model sheet. */
export function AddModelDialogs(props: AddModelDialogsProps) {
  const { form, setForm, filePickerKind } = props
  return (
    <>
      <FetchModelsDialog
        open={props.fetchOpen}
        onClose={props.onFetchClose}
        onFill={props.onFetchFill}
        provider={props.provider}
        apiKey={form.apiKey}
        apiBase={props.apiBase}
        backendOptions={props.providerOptions}
        alreadyAddedModelIds={props.alreadyAddedModelIds}
      />
      <TestModelDialog
        model={null}
        open={props.testOpen}
        onClose={props.onTestClose}
        inlineParams={{
          provider: props.provider,
          model: form.model,
          apiBase: props.apiBase,
          apiKey: form.apiKey,
          authMethod: props.authMethod,
        }}
      />
      <ModelFilePickerDialog
        open={filePickerKind !== null}
        onOpenChange={(isOpen) => !isOpen && props.onFilePickerKindChange(null)}
        kind={filePickerKind ?? "llm"}
        onSelect={(path) => {
          const key =
            filePickerKind === "llm"
              ? "localModelPath"
              : filePickerKind === "executable"
                ? "localExecutablePath"
                : null
          if (key) setForm((current) => ({ ...current, [key]: path }))
          props.onFilePickerKindChange(null)
        }}
      />
    </>
  )
}
