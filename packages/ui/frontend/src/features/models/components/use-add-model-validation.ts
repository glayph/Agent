import { useCallback, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import type { ModelProviderOption } from "@/api/models"

import { type AddForm, validateAddFormState } from "./add-model-form-state"
import { type FieldValidation, validateModelField } from "./model-validation"

interface UseAddModelValidationOptions {
  form: AddForm
  providerIsValid: boolean
  existingModelNames: string[]
  selectedModels: string[]
  providerOptions?: ModelProviderOption[]
}

/** Field errors plus the debounced Model ID validation of the Add Model form. */
export function useAddModelValidation(options: UseAddModelValidationOptions) {
  const { t } = useTranslation()
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof AddForm, string>>
  >({})
  const [modelValidation, setModelValidation] =
    useState<FieldValidation | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const { providerOptions } = options

  const clearFieldError = useCallback(
    (key: keyof AddForm) =>
      setFieldErrors((prev) =>
        prev[key] ? { ...prev, [key]: undefined } : prev,
      ),
    [],
  )

  const validateModelLater = (value: string, provider: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setModelValidation(
        validateModelField(value, provider || undefined, providerOptions),
      )
    }, 300)
  }

  const validate = (): boolean => {
    const errors = validateAddFormState(options.form, {
      providerIsValid: options.providerIsValid,
      existingModelNames: options.existingModelNames,
      selectedModels: options.selectedModels,
      modelValidationError:
        modelValidation?.level === "error"
          ? t(modelValidation.messageKey, modelValidation.messageParams)
          : undefined,
      messages: {
        duplicateModelName: t("models.add.errorDuplicateModelName"),
        providerInvalid: t("models.field.providerInvalid"),
        modelRequired: t("models.add.errorRequired"),
      },
    })
    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const reset = useCallback(() => {
    setFieldErrors({})
    setModelValidation(null)
  }, [])

  return {
    fieldErrors,
    clearFieldError,
    modelValidation,
    setModelValidation,
    validateModelLater,
    validate,
    reset,
  }
}
