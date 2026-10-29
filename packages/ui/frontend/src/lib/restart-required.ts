import type { TFunction } from "i18next"
import { notify } from "@/lib/notify"

export function showRestartRequiredToast(t: TFunction, name: string) {
  notify.warning(t("common.restartRequiredTitle"), {
    id: "restart-required",
    description: t("common.restartRequiredDesc", { name }),
  })
}

export type RuntimeApplyStatus = "applied" | "pending_restart" | "failed"

export function showRuntimeApplyStatusToast(
  t: TFunction,
  savedMessage: string,
  name: string,
  status?: RuntimeApplyStatus,
  error?: string,
  gatewayRestartRequired?: boolean,
) {
  if (status === "failed") {
    notify.error(t("common.saveFailedTitle"), {
      id: `save-failed:${name}`,
      description: error || t("common.saveFailedDesc", { name }),
    })
    return
  }
  if (gatewayRestartRequired) {
    showRestartRequiredToast(t, name)
    return
  }
  if (status === "pending_restart") {
    showRestartRequiredToast(t, name)
    return
  }
  notify.success(savedMessage, { id: `save-success:${name}` })
}

export function showSaveSuccessOrRestartToast(
  t: TFunction,
  savedMessage: string,
  name: string,
  restartRequired: boolean,
  runtimeApplyStatus?: RuntimeApplyStatus,
  runtimeApplyError?: string,
) {
  showRuntimeApplyStatusToast(
    t,
    savedMessage,
    name,
    runtimeApplyStatus ?? (restartRequired ? "pending_restart" : "applied"),
    runtimeApplyError,
    restartRequired,
  )
}
