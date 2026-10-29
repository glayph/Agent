import type { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"

import { maskedSecretPlaceholder } from "@/shared/forms/secret-placeholder"
import { KeyInput } from "@/shared/forms/shared-form"

import { placeholderText } from "./add-model-field-utils"
import { type AddFormFieldSetter, FormRow } from "./add-model-fields"
import type { AddForm } from "./add-model-form-state"
import { AddModelLocalFields } from "./add-model-local-fields"
import type { ModelFilePickerKind } from "./model-file-picker-dialog"

interface AddModelCredentialsProps {
  form: AddForm
  setForm: Dispatch<SetStateAction<AddForm>>
  setField: AddFormFieldSetter
  apiKeyId: string
  isLocalRuntime: boolean
  isOAuth: boolean
  onPickFile: (kind: ModelFilePickerKind | null) => void
}

/** Local llama.cpp fields, or the API key row (hidden for OAuth providers). */
export function AddModelCredentials(props: AddModelCredentialsProps) {
  const { t } = useTranslation()
  const { form, setForm } = props
  if (props.isLocalRuntime) {
    return (
      <AddModelLocalFields
        form={form}
        setForm={setForm}
        setField={props.setField}
        setFilePickerKind={props.onPickFile}
      />
    )
  }
  if (props.isOAuth) return null
  return (
    <FormRow label={t("models.field.apiKey")} htmlFor={props.apiKeyId}>
      <KeyInput
        id={props.apiKeyId}
        name="api_key"
        value={form.apiKey}
        onChange={(value) =>
          setForm((current) => ({ ...current, apiKey: value }))
        }
        placeholder={maskedSecretPlaceholder(
          form.apiKey,
          placeholderText(t("models.field.apiKeyPlaceholder")),
        )}
        autoComplete="off"
      />
    </FormRow>
  )
}
