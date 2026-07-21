import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react"

import { cn } from "@/lib/utils"

function clampSidebarWidth(value: number, minWidth: number, maxWidth: number) {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(value)))
}

interface ResizableSidebarSplitterProps {
  width: number
  minWidth: number
  maxWidth: number
  onWidthChange: (width: number) => void
  collapseBelowWidth?: number
  onCollapse?: (restoreWidth: number) => void
  className?: string
  controls?: string
  label?: string
  storageKey?: string
}

export function ResizableSidebarSplitter({
  width,
  minWidth,
  maxWidth,
  onWidthChange,
  collapseBelowWidth,
  onCollapse,
  className,
  controls,
  label = "Resize sidebar",
  storageKey,
}: ResizableSidebarSplitterProps) {
  const [isDragging, setIsDragging] = useState(false)
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  )
  const dragPointerIdRef = useRef<number | null>(null)
  const latestWidthRef = useRef(width)
  const latestRawWidthRef = useRef(width)
  const animationFrameRef = useRef<number | null>(null)

  useEffect(() => {
    latestWidthRef.current = width
    latestRawWidthRef.current = width
  }, [width])

  useEffect(() => {
    if (!isDragging) return

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect

      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
    }
  }, [isDragging, maxWidth, minWidth, onWidthChange, storageKey])

  const persistWidth = (nextWidth: number) => {
    latestWidthRef.current = nextWidth
    onWidthChange(nextWidth)

    if (!storageKey) return

    try {
      window.localStorage.setItem(storageKey, String(nextWidth))
    } catch {
      // Persisting layout preference is optional.
    }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragPointerIdRef.current = event.pointerId
    dragStateRef.current = {
      startX: event.clientX,
      startWidth: latestWidthRef.current,
    }
    latestRawWidthRef.current = latestWidthRef.current
    setIsDragging(true)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragPointerIdRef.current !== event.pointerId) return

    event.preventDefault()
    const rawWidth = dragState.startWidth + event.clientX - dragState.startX
    latestRawWidthRef.current = rawWidth
    const nextWidth = clampSidebarWidth(rawWidth, minWidth, maxWidth)
    latestWidthRef.current = nextWidth

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current)
    }
    animationFrameRef.current = window.requestAnimationFrame(() => {
      onWidthChange(nextWidth)
      animationFrameRef.current = null
    })
  }

  const finishPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragPointerIdRef.current !== event.pointerId) return

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    if (
      collapseBelowWidth !== undefined &&
      latestRawWidthRef.current < collapseBelowWidth
    ) {
      onCollapse?.(dragStateRef.current?.startWidth ?? latestWidthRef.current)
    } else {
      persistWidth(latestWidthRef.current)
    }

    dragStateRef.current = null
    dragPointerIdRef.current = null
    setIsDragging(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 24 : 8
    let nextWidth: number | undefined

    if (event.key === "ArrowLeft") {
      nextWidth = latestWidthRef.current - step
    } else if (event.key === "ArrowRight") {
      nextWidth = latestWidthRef.current + step
    } else if (event.key === "Home") {
      nextWidth = minWidth
    } else if (event.key === "End") {
      nextWidth = maxWidth
    }

    if (nextWidth === undefined) return

    event.preventDefault()
    persistWidth(clampSidebarWidth(nextWidth, minWidth, maxWidth))
  }

  return (
    <button
      type="button"
      role="separator"
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      data-dragging={isDragging ? "true" : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      onKeyDown={handleKeyDown}
      className={cn(
        "group/splitter relative z-20 hidden w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center self-stretch focus-visible:outline-none md:flex",
        className,
      )}
    >
      <span className="sr-only">{label}</span>
      <span
        aria-hidden="true"
        className={cn(
          "bg-border/70 absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
          "group-hover/splitter:bg-sidebar-ring group-focus-visible/splitter:bg-sidebar-ring",
          isDragging && "bg-sidebar-ring",
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-1/2 left-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors",
          "group-hover/splitter:bg-sidebar-ring/45 group-focus-visible/splitter:bg-sidebar-ring/55",
          isDragging && "bg-sidebar-ring",
        )}
      />
    </button>
  )
}
