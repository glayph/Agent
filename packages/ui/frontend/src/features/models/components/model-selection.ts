/** Empty by design: fetching or retrying never auto-selects provider models. */
export function createEmptyModelSelection(): Set<string> {
  return new Set<string>()
}

/** Pure helpers for fetched-model selection and safe retry after partial saves. */
export function deduplicateModelIds(modelIds: string[]): string[] {
  return [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))]
}

export function toggleVisibleModelSelection(
  selectedIds: Iterable<string>,
  visibleIds: string[],
  unavailableIds: Iterable<string> = [],
): Set<string> {
  const selected = new Set(selectedIds)
  const unavailable = new Set(unavailableIds)
  const selectable = [...new Set(visibleIds)].filter((id) => !unavailable.has(id))
  if (selectable.length > 0 && selectable.every((id) => selected.has(id))) {
    selectable.forEach((id) => selected.delete(id))
  } else {
    selectable.forEach((id) => selected.add(id))
  }
  return selected
}

export function retainUnsuccessfulModelIds(
  requestedIds: string[],
  successfulIds: Iterable<string>,
): string[] {
  const successful = new Set(successfulIds)
  return requestedIds.filter((id) => !successful.has(id))
}

export interface FetchedModelPlan {
  /** De-duplicated ids shown as suggestion badges. */
  suggestions: string[]
  /** Ids that become removable chips (only when two or more were chosen). */
  chips: string[]
  /** Value for the Model field, or null to leave it unchanged. */
  modelField: string | null
}

/**
 * One chosen model fills the Model field; two or more become a chip list and
 * clear the field; an empty choice changes nothing.
 */
export function planFetchedModelFill(modelIds: string[]): FetchedModelPlan {
  const suggestions = deduplicateModelIds(modelIds)
  if (suggestions.length === 0) return { suggestions, chips: [], modelField: null }
  if (suggestions.length === 1) {
    return { suggestions, chips: [], modelField: suggestions[0] }
  }
  return { suggestions, chips: suggestions, modelField: "" }
}
