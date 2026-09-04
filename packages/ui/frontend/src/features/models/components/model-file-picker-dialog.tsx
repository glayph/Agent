import {
  IconArrowLeft,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconLoader2,
} from "@tabler/icons-react"
import { useEffect, useMemo, useState } from "react"

import {
  type FileEntry,
  type FileRoot,
  getFileRoots,
  listFiles,
} from "@/api/files"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog"

export type ModelFilePickerKind = "llm" | "whisper" | "executable"

interface ModelFilePickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: ModelFilePickerKind
  onSelect: (path: string) => void
}

const FILTERS: Record<
  ModelFilePickerKind,
  { title: string; description: string; extensions: string[] }
> = {
  llm: {
    title: "Explore local LLM models",
    description:
      "Select a llama.cpp GGUF model file from the Agent Miki file system.",
    extensions: [".gguf"],
  },
  whisper: {
    title: "Explore Whisper models",
    description:
      "Select a Whisper.cpp model file from the Agent Miki file system.",
    extensions: [".bin", ".gguf"],
  },
  executable: {
    title: "Explore runtime executables",
    description: "Select the local llama-server or whisper-cli executable.",
    extensions: [],
  },
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`
  if (sizeBytes < 1024 * 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function rootLabel(root: FileRoot): string {
  return root.label || root.path
}

export function ModelFilePickerDialog({
  open,
  onOpenChange,
  kind,
  onSelect,
}: ModelFilePickerDialogProps) {
  const filter = FILTERS[kind]
  const [roots, setRoots] = useState<FileRoot[]>([])
  const [currentPath, setCurrentPath] = useState("")
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [selectedPath, setSelectedPath] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadingRoots, setLoadingRoots] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingRoots(true)
    setError("")
    setSelectedPath("")
    getFileRoots()
      .then((response) => {
        if (cancelled) return
        setRoots(response.roots)
        const firstRoot = response.roots[0]
        if (firstRoot) setCurrentPath(firstRoot.path)
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Unable to load file roots.",
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingRoots(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open || !currentPath) return
    let cancelled = false
    setLoading(true)
    setError("")
    listFiles(currentPath)
      .then((listing) => {
        if (cancelled) return
        setCurrentPath(listing.path)
        setParentPath(listing.parentPath)
        setEntries(listing.entries)
      })
      .catch((reason) => {
        if (!cancelled) {
          setEntries([])
          setError(
            reason instanceof Error
              ? reason.message
              : "Unable to read this folder.",
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentPath, open])

  const visibleEntries = useMemo(() => {
    const matchingFiles = entries.filter((entry) => {
      if (entry.type !== "file") return false
      if (filter.extensions.length === 0) return true
      return filter.extensions.includes(entry.extension.toLowerCase())
    })
    const folders = entries.filter((entry) => entry.type === "directory")
    return [...folders, ...matchingFiles]
  }, [entries, filter.extensions])

  const selectCurrentFile = () => {
    if (!selectedPath) return
    onSelect(selectedPath)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>{filter.title}</DialogTitle>
          <DialogDescription>{filter.description}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-4 overflow-hidden p-6 md:grid-cols-[150px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto">
            <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
              Locations
            </p>
            <div className="grid gap-1">
              {loadingRoots ? (
                <IconLoader2 className="text-muted-foreground size-4 animate-spin" />
              ) : (
                roots.map((root) => (
                  <Button
                    key={root.id}
                    type="button"
                    size="sm"
                    variant={currentPath === root.path ? "secondary" : "ghost"}
                    className="justify-start truncate text-left"
                    onClick={() => setCurrentPath(root.path)}
                    title={root.path}
                  >
                    <IconFolder className="size-4 shrink-0" />
                    <span className="truncate">{rootLabel(root)}</span>
                  </Button>
                ))
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
            <div className="bg-muted/30 flex min-w-0 items-center gap-2 border-b px-3 py-2">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={() => parentPath && setCurrentPath(parentPath)}
                disabled={!parentPath || loading}
                aria-label="Go to parent folder"
              >
                <IconArrowLeft className="size-4" />
              </Button>
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs"
                title={currentPath}
              >
                {currentPath || "Loading…"}
              </span>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {filter.extensions.length
                  ? filter.extensions.join(", ")
                  : "files"}
              </Badge>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {loading ? (
                <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
                  <IconLoader2 className="size-4 animate-spin" />
                  Loading folder…
                </div>
              ) : error ? (
                <p
                  className="text-destructive px-3 py-8 text-center text-sm"
                  role="alert"
                >
                  {error}
                </p>
              ) : visibleEntries.length === 0 ? (
                <p className="text-muted-foreground px-3 py-8 text-center text-sm">
                  No matching files in this folder.
                </p>
              ) : (
                <div className="grid gap-1">
                  {visibleEntries.map((entry) => {
                    const isFolder = entry.type === "directory"
                    const selected = selectedPath === entry.path
                    return (
                      <button
                        key={entry.path}
                        type="button"
                        className={`hover:bg-accent flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${selected ? "bg-accent text-accent-foreground" : ""}`}
                        onClick={() => {
                          if (isFolder) {
                            setCurrentPath(entry.path)
                            setSelectedPath("")
                          } else {
                            setSelectedPath(entry.path)
                          }
                        }}
                        onDoubleClick={() => {
                          if (!isFolder) {
                            setSelectedPath(entry.path)
                            onSelect(entry.path)
                            onOpenChange(false)
                          }
                        }}
                        title={entry.path}
                      >
                        {isFolder ? (
                          <IconFolder className="text-primary size-4 shrink-0" />
                        ) : (
                          <IconFile className="text-muted-foreground size-4 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {entry.name}
                        </span>
                        {!isFolder && (
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {formatBytes(entry.sizeBytes)}
                          </span>
                        )}
                        {isFolder && (
                          <IconChevronRight className="text-muted-foreground size-4 shrink-0" />
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="border-t px-6 py-4">
          <div
            className="text-muted-foreground min-w-0 flex-1 truncate text-left font-mono text-xs"
            title={selectedPath}
          >
            {selectedPath || "Select a file, then choose Select model."}
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={selectCurrentFile}
            disabled={!selectedPath || loading}
          >
            Select model
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
