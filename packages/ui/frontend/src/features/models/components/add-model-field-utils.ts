export const inputClass = "h-9 rounded-md shadow-none"

export function joinIds(...ids: Array<string | false | null | undefined>) {
  const value = ids.filter(Boolean).join(" ")
  return value || undefined
}

export function placeholderText(value: string) {
  const trimmed = value.trim()
  if (!trimmed || trimmed.endsWith("…")) return value
  return `${trimmed}…`
}
