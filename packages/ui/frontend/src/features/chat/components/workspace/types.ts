import type { ReactNode } from "react"

export type WorkspaceStatusTone = "neutral" | "success" | "warning" | "info"

export interface WorkspaceStatusPill {
  label: string
  tone?: WorkspaceStatusTone
}

export type WorkspaceAssetKind =
  | "chart"
  | "csv"
  | "document"
  | "file"
  | "report"

export interface WorkspaceAsset {
  id: string
  filename: string
  kind: WorkspaceAssetKind
  url: string
  sourceLabel?: string
}

export interface ContextSummaryItem {
  label: string
  value: ReactNode
}
