import { IconChevronDown } from "@tabler/icons-react"
import type { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { Input } from "@/shared/ui/input"
import { Textarea } from "@/shared/ui/textarea"

import { inputClass, joinIds, placeholderText } from "./add-model-field-utils"
import {
  type AddFormFieldSetter,
  type AddModelFieldIds,
  FormRow,
  SwitchRow,
} from "./add-model-fields"
import type { AddForm } from "./add-model-form-state"

interface AddModelAdvancedFieldsProps {
  form: AddForm
  fieldIds: AddModelFieldIds
  fieldErrors: Partial<Record<keyof AddForm, string>>
  errorId: (key: keyof AddModelFieldIds) => string
  setField: AddFormFieldSetter
  setForm: Dispatch<SetStateAction<AddForm>>
  isOAuth: boolean
  authMethodLocked: boolean
  defaultAuthMethod: string
  apiBasePlaceholder: string
  moreOpen: boolean
  setMoreOpen: Dispatch<SetStateAction<boolean>>
  moreId: string
}

export function AddModelAdvancedFields({
  form,
  fieldIds,
  fieldErrors,
  errorId,
  setField,
  setForm,
  isOAuth,
  authMethodLocked,
  defaultAuthMethod,
  apiBasePlaceholder,
  moreOpen,
  setMoreOpen,
  moreId,
}: AddModelAdvancedFieldsProps) {
  const { t } = useTranslation()
  return (
    <div className="border-t pt-1">
      <button
        type="button"
        onClick={() => setMoreOpen((v) => !v)}
        aria-expanded={moreOpen}
        aria-controls={moreId}
        className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between py-3 text-[13px] transition-colors"
      >
        {t("models.advanced.toggle")}
        <IconChevronDown
          className={cn(
            "size-4 transition-transform duration-200 motion-reduce:transition-none",
            moreOpen && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {moreOpen && (
        <div id={moreId} className="space-y-4 pt-2 pb-1">
          <div className="grid gap-5 sm:grid-cols-2">
            <FormRow
              label={t("models.field.apiBase")}
              htmlFor={fieldIds.apiBase}
            >
              <Input
                id={fieldIds.apiBase}
                name="api_base"
                value={form.apiBase}
                onChange={setField("apiBase")}
                placeholder={placeholderText(apiBasePlaceholder)}
                type="url"
                inputMode="url"
                autoComplete="off"
                className={inputClass}
                disabled={isOAuth}
              />
            </FormRow>
            <FormRow
              label={t("models.add.modelName")}
              htmlFor={fieldIds.modelName}
              error={fieldErrors.modelName}
              errorId={errorId("modelName")}
            >
              <Input
                id={fieldIds.modelName}
                name="model_name"
                value={form.modelName}
                onChange={setField("modelName")}
                placeholder={placeholderText(
                  t("models.add.modelNamePlaceholder"),
                )}
                autoComplete="off"
                className={inputClass}
                aria-invalid={!!fieldErrors.modelName}
                aria-describedby={joinIds(
                  fieldErrors.modelName && errorId("modelName"),
                )}
              />
            </FormRow>
          </div>
          <FormRow label={t("models.field.proxy")} htmlFor={fieldIds.proxy}>
            <Input
              id={fieldIds.proxy}
              name="proxy"
              value={form.proxy}
              onChange={setField("proxy")}
              placeholder={placeholderText("http://127.0.0.1:7890")}
              inputMode="url"
              autoComplete="off"
              className={inputClass}
            />
          </FormRow>

          <div className="grid gap-5 sm:grid-cols-2">
            <FormRow
              label={t("models.field.authMethod")}
              htmlFor={fieldIds.authMethod}
            >
              <Input
                id={fieldIds.authMethod}
                name="auth_method"
                value={authMethodLocked ? defaultAuthMethod : form.authMethod}
                onChange={setField("authMethod")}
                placeholder={placeholderText("oauth")}
                autoComplete="off"
                className={inputClass}
                disabled={authMethodLocked}
              />
            </FormRow>
            <FormRow
              label={t("models.field.connectMode")}
              htmlFor={fieldIds.connectMode}
            >
              <Input
                id={fieldIds.connectMode}
                name="connect_mode"
                value={form.connectMode}
                onChange={setField("connectMode")}
                placeholder={placeholderText("stdio")}
                autoComplete="off"
                className={inputClass}
              />
            </FormRow>
            <FormRow
              label={t("models.field.requestTimeout")}
              htmlFor={fieldIds.requestTimeout}
            >
              <Input
                id={fieldIds.requestTimeout}
                name="request_timeout"
                value={form.requestTimeout}
                onChange={setField("requestTimeout")}
                placeholder={placeholderText("60")}
                type="number"
                inputMode="numeric"
                autoComplete="off"
                className={inputClass}
                min={0}
              />
            </FormRow>
            <FormRow label={t("models.field.rpm")} htmlFor={fieldIds.rpm}>
              <Input
                id={fieldIds.rpm}
                name="rpm"
                value={form.rpm}
                onChange={setField("rpm")}
                placeholder={placeholderText("60")}
                type="number"
                inputMode="numeric"
                autoComplete="off"
                className={inputClass}
                min={0}
              />
            </FormRow>
            <FormRow
              label={t("models.field.thinkingLevel")}
              htmlFor={fieldIds.thinkingLevel}
            >
              <Input
                id={fieldIds.thinkingLevel}
                name="thinking_level"
                value={form.thinkingLevel}
                onChange={setField("thinkingLevel")}
                placeholder={placeholderText(t("models.field.providerDefault"))}
                autoComplete="off"
                className={inputClass}
              />
            </FormRow>
            <FormRow
              label={t("models.field.maxTokensField")}
              htmlFor={fieldIds.maxTokensField}
            >
              <Input
                id={fieldIds.maxTokensField}
                name="max_tokens_field"
                value={form.maxTokensField}
                onChange={setField("maxTokensField")}
                placeholder={placeholderText("max_completion_tokens")}
                autoComplete="off"
                className={inputClass}
              />
            </FormRow>
          </div>

          <FormRow
            label={t("models.field.toolSchemaTransform")}
            htmlFor={fieldIds.toolSchemaTransform}
          >
            <Input
              id={fieldIds.toolSchemaTransform}
              name="tool_schema_transform"
              value={form.toolSchemaTransform}
              onChange={setField("toolSchemaTransform")}
              placeholder={placeholderText("google")}
              autoComplete="off"
              className={inputClass}
            />
          </FormRow>

          <FormRow
            label={t("models.field.workspace")}
            htmlFor={fieldIds.workspace}
          >
            <Input
              id={fieldIds.workspace}
              name="workspace"
              value={form.workspace}
              onChange={setField("workspace")}
              placeholder={placeholderText("/path/to/workspace")}
              autoComplete="off"
              className={inputClass}
            />
          </FormRow>

          <FormRow
            label={t("models.field.extraBody")}
            htmlFor={fieldIds.extraBody}
          >
            <Textarea
              id={fieldIds.extraBody}
              name="extra_body"
              value={form.extraBody}
              onChange={setField("extraBody")}
              placeholder={placeholderText('{"key": "value"}')}
              autoComplete="off"
              className="rounded-md font-mono text-sm shadow-none"
              rows={3}
            />
          </FormRow>

          <FormRow
            label={t("models.field.customHeaders")}
            htmlFor={fieldIds.customHeaders}
          >
            <Textarea
              id={fieldIds.customHeaders}
              name="custom_headers"
              value={form.customHeaders}
              onChange={setField("customHeaders")}
              placeholder={placeholderText('{"X-Source": "value"}')}
              autoComplete="off"
              className="rounded-md font-mono text-sm shadow-none"
              rows={3}
            />
          </FormRow>

          <SwitchRow
            label={t("models.field.streamingEnabled")}
            checked={form.streamingEnabled}
            onCheckedChange={(checked) =>
              setForm((f) => ({ ...f, streamingEnabled: checked }))
            }
          />
        </div>
      )}
    </div>
  )
}
