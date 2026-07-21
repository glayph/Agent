import { createContext, useContext } from "react"

export type ConfirmUnsavedChanges = () => Promise<boolean>

export const UnsavedChangesContext =
  createContext<ConfirmUnsavedChanges | null>(null)

export function useUnsavedChangesConfirmation() {
  return useContext(UnsavedChangesContext)
}
