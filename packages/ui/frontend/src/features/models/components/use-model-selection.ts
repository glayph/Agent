import { useCallback, useState } from "react"

import { type FetchedModelPlan, planFetchedModelFill } from "./model-selection"

/**
 * Fetched suggestions, the multi-select chip list and per-model save failures
 * for the Add Model sheet. Nothing is ever auto-selected: a single fetched
 * model fills the Model field, two or more become chips the user can remove.
 */
export function useModelSelection() {
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [modelFailures, setModelFailures] = useState<Record<string, string>>({})

  const clearSelection = useCallback(() => {
    setSelectedModels([])
    setModelFailures({})
  }, [])

  const resetAll = useCallback(() => {
    setFetchedModels([])
    clearSelection()
  }, [clearSelection])

  const removeSelected = (modelId: string) => {
    setSelectedModels((current) => current.filter((item) => item !== modelId))
    setModelFailures((current) => {
      const next = { ...current }
      delete next[modelId]
      return next
    })
  }

  /** Stores the fetched list and returns how the form should react to it. */
  const applyFetched = (models: string[]): FetchedModelPlan => {
    const plan = planFetchedModelFill(models)
    setFetchedModels(plan.suggestions)
    setModelFailures({})
    setSelectedModels(plan.chips)
    return plan
  }

  return {
    fetchedModels,
    setFetchedModels,
    selectedModels,
    setSelectedModels,
    modelFailures,
    setModelFailures,
    clearSelection,
    resetAll,
    removeSelected,
    applyFetched,
  }
}
