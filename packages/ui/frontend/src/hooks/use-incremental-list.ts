import { useCallback, useEffect, useMemo, useState } from "react"

interface UseIncrementalListOptions<T> {
  items: T[]
  initialCount: number
  step: number
  resetKey?: string | number | boolean | null
  fromEnd?: boolean
}

export function useIncrementalList<T>({
  items,
  initialCount,
  step,
  resetKey,
  fromEnd = false,
}: UseIncrementalListOptions<T>) {
  const [visibleCount, setVisibleCount] = useState(initialCount)

  useEffect(() => {
    setVisibleCount(initialCount)
  }, [initialCount, resetKey])

  const visibleItems = useMemo(() => {
    if (fromEnd) {
      return items.slice(Math.max(0, items.length - visibleCount))
    }

    return items.slice(0, visibleCount)
  }, [fromEnd, items, visibleCount])

  const hiddenCount = Math.max(0, items.length - visibleItems.length)

  const showMore = useCallback(() => {
    setVisibleCount((current) => Math.min(items.length, current + step))
  }, [items.length, step])

  return {
    hiddenCount,
    showMore,
    visibleCount,
    visibleItems,
  }
}
