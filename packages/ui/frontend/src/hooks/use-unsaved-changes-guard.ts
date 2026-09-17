import { useBlocker } from "@tanstack/react-router"
import { useCallback } from "react"

import { useUnsavedChangesConfirmation } from "@/hooks/use-unsaved-changes-confirmation"

export function useUnsavedChangesGuard(enabled: boolean) {
  const confirmUnsavedChanges = useUnsavedChangesConfirmation()
  const shouldBlockFn = useCallback(async () => {
    if (!enabled) {
      return false
    }
    const shouldLeave = confirmUnsavedChanges
      ? await confirmUnsavedChanges()
      : true
    return !shouldLeave
  }, [confirmUnsavedChanges, enabled])

  useBlocker({
    disabled: !enabled,
    enableBeforeUnload: () => enabled,
    shouldBlockFn,
  })
}
