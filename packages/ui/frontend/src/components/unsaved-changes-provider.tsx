import { type ReactNode, useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  type ConfirmUnsavedChanges,
  UnsavedChangesContext,
} from "@/hooks/use-unsaved-changes-confirmation"

interface ConfirmationRequest {
  resolve: (confirmed: boolean) => void
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [request, setRequest] = useState<ConfirmationRequest | null>(null)

  const confirm = useCallback<ConfirmUnsavedChanges>(
    () =>
      new Promise((resolve) => {
        setRequest({ resolve })
      }),
    [],
  )

  const closeRequest = useCallback((confirmed: boolean) => {
    setRequest((current) => {
      current?.resolve(confirmed)
      return null
    })
  }, [])

  const contextValue = useMemo(() => confirm, [confirm])

  return (
    <UnsavedChangesContext.Provider value={contextValue}>
      {children}
      <AlertDialog
        open={Boolean(request)}
        onOpenChange={(open) => {
          if (!open) {
            closeRequest(false)
          }
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common.saveChangesTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("common.unsavedChangesPrompt")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => closeRequest(false)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => closeRequest(true)}
            >
              {t("common.leave")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UnsavedChangesContext.Provider>
  )
}
