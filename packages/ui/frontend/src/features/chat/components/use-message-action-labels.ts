import { useMemo } from "react"
import { useTranslation } from "react-i18next"

export interface MessageActionLabels {
  copy: string
  copied: string
  edit: string
  delete: string
  fork: string
  retry: string
  retryDisabled: string
  deleteConfirmTitle: string
  deleteConfirmDescription: string
  cancel: string
  deleteConfirmAction: string
  inspect: string
  moreActions: string
  model: string
}

export function useMessageActionLabels(): MessageActionLabels {
  const { t } = useTranslation()
  return useMemo(
    () => ({
      copy: t("chat.copyMessage"),
      copied: t("chat.copiedLabel"),
      edit: t("chat.actions.edit", { defaultValue: "Edit message" }),
      delete: t("chat.actions.delete", { defaultValue: "Delete message" }),
      fork: t("chat.actions.fork", { defaultValue: "Fork from here" }),
      retry: t("chat.actions.retry", { defaultValue: "Retry" }),
      retryDisabled: t("chat.actions.retryUnavailable", {
        defaultValue: "Connect chat before retrying",
      }),
      deleteConfirmTitle: t("chat.actions.deleteConfirmTitle", {
        defaultValue: "Delete message?",
      }),
      deleteConfirmDescription: t("chat.actions.deleteConfirmDescription", {
        defaultValue: "This message will be removed from the conversation.",
      }),
      cancel: t("common.cancel"),
      deleteConfirmAction: t("chat.actions.delete", {
        defaultValue: "Delete message",
      }),
      inspect: t("chat.actions.inspect", { defaultValue: "Inspect agent" }),
      moreActions: t("chat.actions.more", { defaultValue: "More message actions" }),
      model: t("chat.actions.modelLabel", { defaultValue: "Model" }),
    }),
    [t],
  )
}
