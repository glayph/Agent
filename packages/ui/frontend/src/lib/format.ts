const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  notation: "compact",
})
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
})

export function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value)
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B"
  }

  const units = ["B", "KB", "MB", "GB", "TB"] as const
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  )
  const value = bytes / 1024 ** exponent

  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= 10 || exponent === 0 ? 0 : 1,
  }).format(value)} ${units[exponent]}`
}

export function formatDateTime(value?: string | null): string {
  if (!value) {
    return "-"
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date)
}

export function formatDateOnly(value?: string | null): string {
  if (!value) {
    return "-"
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date)
}
