const runDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

export function formatRunDate(value?: string): string {
  if (!value) return "Not set"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : runDateFormatter.format(date)
}

export function formatOptionalRunDate(value?: string): string {
  return value ? formatRunDate(value) : "Not started"
}
