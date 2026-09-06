import type { TFunction } from "i18next"
import { toast } from "sonner"

export function showRestartRequiredToast(t: TFunction, name: string) {
  toast.warning(t("common.restartRequiredTitle"), {
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
    toast.error(t("common.saveFailedTitle"), {
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
  toast.success(savedMessage)
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
