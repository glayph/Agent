import { IconLoader2, IconPlugConnected } from "@tabler/icons-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/shared/ui/button"
import { SheetFooter } from "@/shared/ui/sheet"

interface AddModelFooterProps {
  saving: boolean
  canTest: boolean
  canSave: boolean
  onTest: () => void
  onCancel: () => void
  onSave: () => void
}

export function AddModelFooter(props: AddModelFooterProps) {
  const { t } = useTranslation()
  return (
    <SheetFooter className="flex-row items-center justify-between gap-2 border-t px-5 py-3 sm:justify-between">
      <Button
        type="button"
        variant="ghost"
        className="text-muted-foreground hover:text-foreground -ml-2 rounded-md"
        onClick={props.onTest}
        disabled={!props.canTest}
      >
        <IconPlugConnected className="size-4" aria-hidden="true" />
        {t("models.test.testConnection")}
      </Button>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          className="rounded-md"
          onClick={props.onCancel}
          disabled={props.saving}
        >
          {t("common.cancel")}
        </Button>
        <Button
          className="rounded-md px-5"
          onClick={props.onSave}
          disabled={!props.canSave || props.saving}
        >
          {props.saving && <IconLoader2 className="size-4 animate-spin" />}
          {t("models.add.confirm")}
        </Button>
      </div>
    </SheetFooter>
  )
}
