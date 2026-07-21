import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowLeft,
  IconArrowUp,
  IconBrandAngular,
  IconBrandCSharp,
  IconBrandCpp,
  IconBrandDocker,
  IconBrandGit,
  IconBrandGolang,
  IconBrandJavascript,
  IconBrandKotlin,
  IconBrandNpm,
  IconBrandPhp,
  IconBrandPython,
  IconBrandReact,
  IconBrandRust,
  IconBrandSass,
  IconBrandSwift,
  IconBrandTypescript,
  IconBrandVue,
  IconCertificate,
  IconChecks,
  IconCoffee,
  IconCopy,
  IconDatabase,
  IconDeviceDesktop,
  IconDeviceFloppy,
  IconDotsVertical,
  IconDownload,
  IconFile,
  IconFileCode,
  IconFileDescription,
  IconFilePlus,
  IconFileSpreadsheet,
  IconFileTypeDoc,
  IconFileTypeDocx,
  IconFileTypePdf,
  IconFileTypePpt,
  IconFileTypeSql,
  IconFileTypeXls,
  IconFileZip,
  IconFolder,
  IconFolderPlus,
  IconHome,
  IconHtml,
  IconJson,
  IconLockCode,
  IconMarkdown,
  IconMusic,
  IconPackage,
  IconPalette,
  IconPencil,
  IconPhoto,
  IconPinned,
  IconPinnedOff,
  IconPlayerPlay,
  IconRefresh,
  IconScissors,
  IconScript,
  IconSettings,
  IconSql,
  IconTerminal2,
  IconTrash,
  IconTypography,
  IconUpload,
  IconVideo,
} from "@tabler/icons-react"
import * as React from "react"
import { useTranslation } from "react-i18next"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { toast } from "sonner"

import {
  type DirectoryListing,
  type FileEntry,
  type FileRoot,
  type ReadFileResponse,
  copyFileItems,
  createFileItem,
  deleteFileItem,
  downloadArchiveUrl,
  downloadFileUrl,
  getFileRoots,
  listFiles,
  moveFileItems,
  previewFileUrl,
  readFile,
  renameFileItem,
  runFileItem,
  uploadFile,
  writeFile,
} from "@/api/files"
import { launcherFetch } from "@/api/http"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useIncrementalList } from "@/hooks/use-incremental-list"
import { formatFileSize } from "@/lib/format"
import { cn } from "@/lib/utils"

type ExplorerPage =
  | { kind: "system" }
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string }

type RootGroup = {
  id: string
  title: string
  roots: FileRoot[]
}

type FilePreviewKind =
  | "audio"
  | "csv"
  | "image"
  | "json"
  | "markdown"
  | "pdf"
  | "text"
  | "video"

type ExplorerOperation =
  | { kind: "create"; path: string; itemType: "file" | "directory" }
  | { kind: "rename"; oldPath: string; newPath: string }
  | {
      kind: "copy"
      sourcePaths: string[]
      destinationPath: string
      copiedPaths: string[]
    }
  | {
      kind: "move"
      sourcePaths: string[]
      movedPaths: string[]
    }

type DriveTextDialogState =
  | { kind: "create"; itemType: "file" | "directory"; parentPath: string }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "copy"; entries: FileEntry[]; destinationPath: string }
  | { kind: "move"; entries: FileEntry[]; destinationPath: string }

type DriveDeleteDialogState = { entries: FileEntry[] } | null

const PIN_STORAGE_KEY = "Hiro-file-explorer-pins"
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
])
const AUDIO_EXTENSIONS = new Set([".flac", ".m4a", ".mp3", ".ogg", ".wav"])
const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".ogv", ".webm"])
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"])
const CSV_EXTENSIONS = new Set([".csv", ".tsv"])
const JSON_EXTENSIONS = new Set([".json", ".jsonc"])
const ARCHIVE_EXTENSIONS = new Set([
  ".7z",
  ".br",
  ".bz2",
  ".cab",
  ".gz",
  ".iso",
  ".rar",
  ".tar",
  ".tgz",
  ".xz",
  ".zip",
])
const EXECUTABLE_EXTENSIONS = new Set([
  ".apk",
  ".app",
  ".bat",
  ".cmd",
  ".com",
  ".deb",
  ".dll",
  ".dmg",
  ".exe",
  ".msi",
  ".ps1",
  ".rpm",
  ".sh",
])
const FONT_EXTENSIONS = new Set([".eot", ".otf", ".ttf", ".woff", ".woff2"])
const DESIGN_EXTENSIONS = new Set([".ai", ".fig", ".psd", ".sketch", ".xd"])
const DATABASE_EXTENSIONS = new Set([".db", ".mdb", ".sqlite", ".sqlite3"])
const CONFIG_EXTENSIONS = new Set([
  ".conf",
  ".config",
  ".env",
  ".ini",
  ".lock",
  ".properties",
  ".toml",
  ".yaml",
  ".yml",
])
const CODE_EXTENSIONS = new Set([
  ".astro",
  ".c",
  ".clj",
  ".cljs",
  ".cmake",
  ".dart",
  ".erl",
  ".ex",
  ".exs",
  ".fs",
  ".fsx",
  ".graphql",
  ".groovy",
  ".h",
  ".hpp",
  ".hs",
  ".lua",
  ".m",
  ".mm",
  ".nim",
  ".pl",
  ".r",
  ".scala",
  ".sol",
  ".svelte",
  ".vb",
  ".zig",
])

type FileIconConfig = {
  Icon: typeof IconFile
  label: string
  swatch: string
}

const fileIconConfigs: Record<string, FileIconConfig> = {
  ".ai": {
    Icon: IconPalette,
    label: "Illustrator file",
    swatch: "bg-orange-500/15 text-orange-300 border-orange-400/20",
  },
  ".apk": {
    Icon: IconPackage,
    label: "Android package",
    swatch: "bg-lime-500/15 text-lime-300 border-lime-400/20",
  },
  ".bat": {
    Icon: IconTerminal2,
    label: "Batch script",
    swatch: "bg-slate-400/15 text-slate-200 border-slate-300/20",
  },
  ".c": {
    Icon: IconFileCode,
    label: "C source",
    swatch: "bg-sky-500/15 text-sky-300 border-sky-400/20",
  },
  ".cmd": {
    Icon: IconTerminal2,
    label: "Command script",
    swatch: "bg-slate-400/15 text-slate-200 border-slate-300/20",
  },
  ".cpp": {
    Icon: IconBrandCpp,
    label: "C++ source",
    swatch: "bg-sky-500/15 text-sky-300 border-sky-400/20",
  },
  ".cs": {
    Icon: IconBrandCSharp,
    label: "C# source",
    swatch: "bg-violet-500/15 text-violet-300 border-violet-400/20",
  },
  ".css": {
    Icon: IconBrandSass,
    label: "CSS file",
    swatch: "bg-blue-500/15 text-blue-300 border-blue-400/20",
  },
  ".csv": {
    Icon: IconFileSpreadsheet,
    label: "CSV file",
    swatch: "bg-emerald-500/15 text-emerald-300 border-emerald-400/20",
  },
  ".db": {
    Icon: IconDatabase,
    label: "Database file",
    swatch: "bg-cyan-500/15 text-cyan-300 border-cyan-400/20",
  },
  ".deb": {
    Icon: IconPackage,
    label: "Debian package",
    swatch: "bg-rose-500/15 text-rose-300 border-rose-400/20",
  },
  ".dll": {
    Icon: IconSettings,
    label: "Library file",
    swatch: "bg-zinc-400/15 text-zinc-200 border-zinc-300/20",
  },
  ".dmg": {
    Icon: IconPackage,
    label: "Disk image",
    swatch: "bg-stone-400/15 text-stone-200 border-stone-300/20",
  },
  ".doc": {
    Icon: IconFileTypeDoc,
    label: "Word document",
    swatch: "bg-blue-500/15 text-blue-300 border-blue-400/20",
  },
  ".docx": {
    Icon: IconFileTypeDocx,
    label: "Word document",
    swatch: "bg-blue-500/15 text-blue-300 border-blue-400/20",
  },
  ".dockerfile": {
    Icon: IconBrandDocker,
    label: "Docker file",
    swatch: "bg-sky-500/15 text-sky-300 border-sky-400/20",
  },
  ".env": {
    Icon: IconLockCode,
    label: "Environment file",
    swatch: "bg-yellow-500/15 text-yellow-300 border-yellow-400/20",
  },
  ".exe": {
    Icon: IconPlayerPlay,
    label: "Executable file",
    swatch: "bg-lime-500/15 text-lime-300 border-lime-400/20",
  },
  ".fig": {
    Icon: IconPalette,
    label: "Figma file",
    swatch: "bg-pink-500/15 text-pink-300 border-pink-400/20",
  },
  ".go": {
    Icon: IconBrandGolang,
    label: "Go source",
    swatch: "bg-cyan-500/15 text-cyan-300 border-cyan-400/20",
  },
  ".h": {
    Icon: IconFileCode,
    label: "Header file",
    swatch: "bg-sky-500/15 text-sky-300 border-sky-400/20",
  },
  ".hpp": {
    Icon: IconBrandCpp,
    label: "C++ header",
    swatch: "bg-sky-500/15 text-sky-300 border-sky-400/20",
  },
  ".html": {
    Icon: IconHtml,
    label: "HTML file",
    swatch: "bg-orange-500/15 text-orange-300 border-orange-400/20",
  },
  ".ini": {
    Icon: IconSettings,
    label: "INI config",
    swatch: "bg-zinc-400/15 text-zinc-200 border-zinc-300/20",
  },
  ".iso": {
    Icon: IconPackage,
    label: "Disk image",
    swatch: "bg-stone-400/15 text-stone-200 border-stone-300/20",
  },
  ".java": {
    Icon: IconCoffee,
    label: "Java source",
    swatch: "bg-red-500/15 text-red-300 border-red-400/20",
  },
  ".js": {
    Icon: IconBrandJavascript,
    label: "JavaScript source",
    swatch: "bg-yellow-500/15 text-yellow-300 border-yellow-400/20",
  },
  ".json": {
    Icon: IconJson,
    label: "JSON file",
    swatch: "bg-amber-500/15 text-amber-300 border-amber-400/20",
  },
  ".jsonc": {
    Icon: IconJson,
    label: "JSON file",
    swatch: "bg-amber-500/15 text-amber-300 border-amber-400/20",
  },
  ".jsx": {
    Icon: IconBrandReact,
    label: "React source",
    swatch: "bg-cyan-500/15 text-cyan-300 border-cyan-400/20",
  },
  ".kt": {
    Icon: IconBrandKotlin,
    label: "Kotlin source",
    swatch: "bg-violet-500/15 text-violet-300 border-violet-400/20",
  },
  ".lock": {
    Icon: IconLockCode,
    label: "Lock file",
    swatch: "bg-yellow-500/15 text-yellow-300 border-yellow-400/20",
  },
  ".log": {
    Icon: IconScript,
    label: "Log file",
    swatch: "bg-stone-400/15 text-stone-200 border-stone-300/20",
  },
  ".md": {
    Icon: IconMarkdown,
    label: "Markdown file",
    swatch: "bg-indigo-500/15 text-indigo-300 border-indigo-400/20",
  },
  ".mdx": {
    Icon: IconMarkdown,
    label: "MDX file",
    swatch: "bg-indigo-500/15 text-indigo-300 border-indigo-400/20",
  },
  ".msi": {
    Icon: IconPackage,
    label: "Installer package",
    swatch: "bg-lime-500/15 text-lime-300 border-lime-400/20",
  },
  ".pdf": {
    Icon: IconFileTypePdf,
    label: "PDF file",
    swatch: "bg-red-500/15 text-red-300 border-red-400/20",
  },
  ".php": {
    Icon: IconBrandPhp,
    label: "PHP source",
    swatch: "bg-indigo-500/15 text-indigo-300 border-indigo-400/20",
  },
  ".ppt": {
    Icon: IconFileTypePpt,
    label: "PowerPoint file",
    swatch: "bg-orange-500/15 text-orange-300 border-orange-400/20",
  },
  ".pptx": {
    Icon: IconFileTypePpt,
    label: "PowerPoint file",
    swatch: "bg-orange-500/15 text-orange-300 border-orange-400/20",
  },
  ".ps1": {
    Icon: IconTerminal2,
    label: "PowerShell script",
    swatch: "bg-blue-500/15 text-blue-300 border-blue-400/20",
  },
  ".psd": {
    Icon: IconPalette,
    label: "Photoshop file",
    swatch: "bg-sky-500/15 text-sky-300 border-sky-400/20",
  },
  ".py": {
    Icon: IconBrandPython,
    label: "Python source",
    swatch: "bg-yellow-500/15 text-yellow-300 border-yellow-400/20",
  },
  ".rb": {
    Icon: IconFileCode,
    label: "Ruby source",
    swatch: "bg-red-500/15 text-red-300 border-red-400/20",
  },
  ".rpm": {
    Icon: IconPackage,
    label: "RPM package",
    swatch: "bg-rose-500/15 text-rose-300 border-rose-400/20",
  },
  ".rs": {
    Icon: IconBrandRust,
    label: "Rust source",
    swatch: "bg-orange-500/15 text-orange-300 border-orange-400/20",
  },
  ".sass": {
    Icon: IconBrandSass,
    label: "Sass file",
    swatch: "bg-pink-500/15 text-pink-300 border-pink-400/20",
  },
  ".scss": {
    Icon: IconBrandSass,
    label: "Sass file",
    swatch: "bg-pink-500/15 text-pink-300 border-pink-400/20",
  },
  ".sh": {
    Icon: IconTerminal2,
    label: "Shell script",
    swatch: "bg-emerald-500/15 text-emerald-300 border-emerald-400/20",
  },
  ".sketch": {
    Icon: IconPalette,
    label: "Sketch file",
    swatch: "bg-amber-500/15 text-amber-300 border-amber-400/20",
  },
  ".sql": {
    Icon: IconFileTypeSql,
    label: "SQL file",
    swatch: "bg-cyan-500/15 text-cyan-300 border-cyan-400/20",
  },
  ".sqlite": {
    Icon: IconDatabase,
    label: "SQLite database",
    swatch: "bg-cyan-500/15 text-cyan-300 border-cyan-400/20",
  },
  ".sqlite3": {
    Icon: IconDatabase,
    label: "SQLite database",
    swatch: "bg-cyan-500/15 text-cyan-300 border-cyan-400/20",
  },
  ".svg": {
    Icon: IconPalette,
    label: "SVG image",
    swatch: "bg-pink-500/15 text-pink-300 border-pink-400/20",
  },
  ".swift": {
    Icon: IconBrandSwift,
    label: "Swift source",
    swatch: "bg-orange-500/15 text-orange-300 border-orange-400/20",
  },
  ".toml": {
    Icon: IconSettings,
    label: "TOML config",
    swatch: "bg-zinc-400/15 text-zinc-200 border-zinc-300/20",
  },
  ".ts": {
    Icon: IconBrandTypescript,
    label: "TypeScript source",
    swatch: "bg-blue-500/15 text-blue-300 border-blue-400/20",
  },
  ".tsx": {
    Icon: IconBrandReact,
    label: "React TypeScript source",
    swatch: "bg-cyan-500/15 text-cyan-300 border-cyan-400/20",
  },
  ".rtf": {
    Icon: IconFileDescription,
    label: "Rich text file",
    swatch: "bg-teal-500/15 text-teal-300 border-teal-400/20",
  },
  ".txt": {
    Icon: IconFileDescription,
    label: "Text file",
    swatch: "bg-teal-500/15 text-teal-300 border-teal-400/20",
  },
  ".vue": {
    Icon: IconBrandVue,
    label: "Vue source",
    swatch: "bg-emerald-500/15 text-emerald-300 border-emerald-400/20",
  },
  ".xls": {
    Icon: IconFileTypeXls,
    label: "Excel file",
    swatch: "bg-emerald-500/15 text-emerald-300 border-emerald-400/20",
  },
  ".xlsx": {
    Icon: IconFileTypeXls,
    label: "Excel file",
    swatch: "bg-emerald-500/15 text-emerald-300 border-emerald-400/20",
  },
  ".xml": {
    Icon: IconHtml,
    label: "XML file",
    swatch: "bg-orange-500/15 text-orange-300 border-orange-400/20",
  },
  ".yaml": {
    Icon: IconSettings,
    label: "YAML config",
    swatch: "bg-zinc-400/15 text-zinc-200 border-zinc-300/20",
  },
  ".yml": {
    Icon: IconSettings,
    label: "YAML config",
    swatch: "bg-zinc-400/15 text-zinc-200 border-zinc-300/20",
  },
}

function fileIconConfig(entry: FileEntry): FileIconConfig {
  const extension = extensionName(entry.name || entry.path)
  const name = entry.name.toLowerCase()
  const directMatch =
    fileIconConfigs[extension] ||
    fileIconConfigs[name === "dockerfile" ? ".dockerfile" : ""]
  if (directMatch) return directMatch
  if (IMAGE_EXTENSIONS.has(extension)) {
    return {
      Icon: IconPhoto,
      label: "Image file",
      swatch: "bg-pink-500/15 text-pink-300 border-pink-400/20",
    }
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return {
      Icon: IconMusic,
      label: "Audio file",
      swatch: "bg-purple-500/15 text-purple-300 border-purple-400/20",
    }
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return {
      Icon: IconVideo,
      label: "Video file",
      swatch: "bg-rose-500/15 text-rose-300 border-rose-400/20",
    }
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return {
      Icon: IconFileZip,
      label: "Archive file",
      swatch: "bg-amber-500/15 text-amber-300 border-amber-400/20",
    }
  }
  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    return {
      Icon: IconPlayerPlay,
      label: "Executable file",
      swatch: "bg-lime-500/15 text-lime-300 border-lime-400/20",
    }
  }
  if (FONT_EXTENSIONS.has(extension)) {
    return {
      Icon: IconTypography,
      label: "Font file",
      swatch: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-400/20",
    }
  }
  if (DESIGN_EXTENSIONS.has(extension)) {
    return {
      Icon: IconPalette,
      label: "Design file",
      swatch: "bg-pink-500/15 text-pink-300 border-pink-400/20",
    }
  }
  if (DATABASE_EXTENSIONS.has(extension)) {
    return {
      Icon: IconDatabase,
      label: "Database file",
      swatch: "bg-cyan-500/15 text-cyan-300 border-cyan-400/20",
    }
  }
  if (CONFIG_EXTENSIONS.has(extension)) {
    return {
      Icon: IconSettings,
      label: "Config file",
      swatch: "bg-zinc-400/15 text-zinc-200 border-zinc-300/20",
    }
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return {
      Icon: IconFileCode,
      label: "Code file",
      swatch: "bg-sky-500/15 text-sky-300 border-sky-400/20",
    }
  }
  if (extension === ".pem" || extension === ".crt" || extension === ".key") {
    return {
      Icon: IconCertificate,
      label: "Certificate file",
      swatch: "bg-yellow-500/15 text-yellow-300 border-yellow-400/20",
    }
  }
  if (extension === ".npmrc" || name === "package.json") {
    return {
      Icon: IconBrandNpm,
      label: "NPM file",
      swatch: "bg-red-500/15 text-red-300 border-red-400/20",
    }
  }
  if (name === ".gitignore" || name === ".gitattributes") {
    return {
      Icon: IconBrandGit,
      label: "Git file",
      swatch: "bg-orange-500/15 text-orange-300 border-orange-400/20",
    }
  }
  if (extension === ".sql") {
    return {
      Icon: IconSql,
      label: "SQL file",
      swatch: "bg-cyan-500/15 text-cyan-300 border-cyan-400/20",
    }
  }
  if (extension === ".component" || extension === ".module") {
    return {
      Icon: IconBrandAngular,
      label: "Angular file",
      swatch: "bg-red-500/15 text-red-300 border-red-400/20",
    }
  }
  return {
    Icon: IconFile,
    label: "File",
    swatch: "bg-muted text-muted-foreground border-border",
  }
}

function extensionName(filePath: string): string {
  const name = basename(filePath)
  const dotIndex = name.lastIndexOf(".")
  return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : ""
}

function previewKind(filePath: string): FilePreviewKind {
  const extension = extensionName(filePath)
  if (IMAGE_EXTENSIONS.has(extension)) return "image"
  if (AUDIO_EXTENSIONS.has(extension)) return "audio"
  if (VIDEO_EXTENSIONS.has(extension)) return "video"
  if (extension === ".pdf") return "pdf"
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown"
  if (CSV_EXTENSIONS.has(extension)) return "csv"
  if (JSON_EXTENSIONS.has(extension)) return "json"
  return "text"
}

function usesInlineStream(kind: FilePreviewKind): boolean {
  return (
    kind === "image" || kind === "audio" || kind === "video" || kind === "pdf"
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function directoryName(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "")
  const separatorIndex = Math.max(
    normalized.lastIndexOf("\\"),
    normalized.lastIndexOf("/"),
  )
  if (separatorIndex <= 0) return filePath
  return normalized.slice(0, separatorIndex)
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "")
  const parts = normalized.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

function joinPath(parentPath: string, childName: string): string {
  const separator =
    parentPath.includes("/") && !parentPath.includes("\\") ? "/" : "\\"
  const normalizedParent = parentPath.replace(/[\\/]+$/, "")
  return `${normalizedParent}${separator}${childName}`
}

function readPinnedPaths(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PIN_STORAGE_KEY) || "[]")
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    return []
  }
}

function writePinnedPaths(paths: string[]): void {
  localStorage.setItem(
    PIN_STORAGE_KEY,
    JSON.stringify(Array.from(new Set(paths))),
  )
}

function storagePercent(root: FileRoot): number {
  const totalBytes = root.storage?.totalBytes ?? 0
  const usedBytes = root.storage?.usedBytes ?? 0
  if (totalBytes <= 0) return 0
  return Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100))
}

function storageText(
  root: FileRoot,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const storage = root.storage
  if (!storage || storage.totalBytes <= 0) return root.path
  return t("drive.storage.freeOf", {
    free: formatFileSize(storage.freeBytes),
    total: formatFileSize(storage.totalBytes),
  })
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function parseDelimitedRows(
  content: string,
  delimiter: "," | "\t",
): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    const next = content[index + 1]
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (!quoted && char === delimiter) {
      row.push(cell)
      cell = ""
      continue
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
      if (char === "\r" && next === "\n") index += 1
      continue
    }
    cell += char
  }

  row.push(cell)
  if (row.some((value) => value.length > 0)) rows.push(row)
  return rows
}

function JsonPreview({ content }: { content: string }) {
  let formatted = ""
  let parseError = ""
  try {
    formatted = JSON.stringify(JSON.parse(content), null, 2)
  } catch (err) {
    parseError = errorMessage(err)
  }

  if (parseError) {
    return <div className="text-muted-foreground p-4 text-sm">{parseError}</div>
  }

  return (
    <pre className="min-h-0 overflow-auto p-4 font-mono text-[13px] leading-6">
      {formatted}
    </pre>
  )
}

function CsvPreview({
  content,
  delimiter,
}: {
  content: string
  delimiter: "," | "\t"
}) {
  const { t } = useTranslation()
  const rows = parseDelimitedRows(content, delimiter).slice(0, 201)
  const header = rows[0] ?? []
  const body = rows.slice(1)

  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground p-4 text-sm">
        {t("drive.empty")}
      </div>
    )
  }

  return (
    <div className="min-h-0 overflow-auto p-3">
      <table className="w-full min-w-max border-collapse text-left text-xs">
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th
                key={`${index}:${cell}`}
                className="border-border bg-muted sticky top-0 border px-2 py-1 font-medium"
              >
                {cell || t("drive.columns.numbered", { number: index + 1 })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {header.map((_cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border-border max-w-64 truncate border px-2 py-1"
                >
                  {row[cellIndex] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 200 && (
        <div className="text-muted-foreground mt-2 text-xs">
          {t("drive.preview.showingRows", { count: 200 })}
        </div>
      )}
    </div>
  )
}

function RichTextPreview({
  path,
  content,
  kind,
}: {
  path: string
  content: string
  kind: FilePreviewKind
}) {
  if (kind === "markdown") {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none overflow-auto p-4">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    )
  }
  if (kind === "csv") {
    return (
      <CsvPreview
        content={content}
        delimiter={extensionName(path) === ".tsv" ? "\t" : ","}
      />
    )
  }
  if (kind === "json") {
    return <JsonPreview content={content} />
  }
  return null
}

function pageFromLocation(): ExplorerPage {
  const params = new URLSearchParams(window.location.search)
  const file = params.get("file")?.trim()
  if (file) return { kind: "file", path: file }
  const path = params.get("path")?.trim()
  if (path) return { kind: "directory", path }
  return { kind: "system" }
}

function pageUrl(page: ExplorerPage): string {
  const params = new URLSearchParams()
  if (page.kind === "directory") params.set("path", page.path)
  if (page.kind === "file") params.set("file", page.path)
  const query = params.toString()
  return query ? `/drive?${query}` : "/drive"
}

function samePage(a: ExplorerPage, b: ExplorerPage): boolean {
  return (
    a.kind === b.kind &&
    ("path" in a ? a.path : "") === ("path" in b ? b.path : "")
  )
}

function rootGroups(
  roots: FileRoot[],
  t: (key: string, options?: Record<string, unknown>) => string,
): RootGroup[] {
  const seen = new Set<string>()
  const uniqueRoots = roots.filter((root) => {
    const key = root.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const quickAccess = uniqueRoots.filter((root) => root.kind === "quickAccess")
  const drives = uniqueRoots.filter(
    (root) => root.kind === "drive" || root.kind === "root",
  )
  const locations = uniqueRoots.filter(
    (root) =>
      root.kind !== "quickAccess" &&
      root.kind !== "drive" &&
      root.kind !== "root",
  )

  return [
    {
      id: "quick-access",
      title: t("drive.groups.quickAccess"),
      roots: quickAccess,
    },
    { id: "drives", title: t("drive.groups.drives"), roots: drives },
    { id: "locations", title: t("drive.groups.locations"), roots: locations },
  ].filter((group) => group.roots.length > 0)
}

function RootIcon({ kind }: { kind: FileRoot["kind"] }) {
  if (kind === "drive" || kind === "root") {
    return <IconDeviceDesktop className="size-4" />
  }
  if (kind === "quickAccess") {
    return <IconFolder className="size-4" />
  }
  return <IconHome className="size-4" />
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  const { t } = useTranslation()

  if (entry.type === "directory") {
    return (
      <span
        title={t("drive.item.folder")}
        className="flex size-7 shrink-0 items-center justify-center rounded-md border border-amber-400/20 bg-amber-500/15 text-amber-300"
      >
        <IconFolder className="size-4" />
      </span>
    )
  }
  const config = fileIconConfig(entry)
  const Icon = config.Icon
  return (
    <span
      title={t("drive.item.file")}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md border",
        config.swatch,
      )}
    >
      <Icon className="size-4" />
    </span>
  )
}

function ToolButton({
  label,
  children,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  label: string
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-transparent transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

function MenuButton({ label }: { label: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        title={label}
        aria-label={label}
        className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-transparent transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <IconDotsVertical className="size-4" />
      </button>
    </DropdownMenuTrigger>
  )
}

function SystemPage({
  groups,
  loading,
  onOpenRoot,
}: {
  groups: RootGroup[]
  loading: boolean
  onOpenRoot: (root: FileRoot) => void
}) {
  const { t } = useTranslation()

  if (loading) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        {t("labels.loading")}
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-5">
      {groups.map((group) => (
        <section key={group.id} className="mb-7 last:mb-0">
          <h2 className="text-muted-foreground mb-2 text-xs font-medium uppercase">
            {group.title}
          </h2>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 xl:grid-cols-3">
            {group.roots.map((root) => (
              <button
                key={`${root.kind}:${root.path}`}
                type="button"
                onClick={() => onOpenRoot(root)}
                className="hover:bg-accent focus-visible:ring-ring flex min-h-16 min-w-0 items-center gap-3 rounded-md px-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                  <RootIcon kind={root.kind} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {root.label}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {storageText(root, t)}
                  </span>
                  {root.storage && (
                    <span
                      className="bg-muted mt-2 block h-1.5 overflow-hidden rounded-full"
                      aria-label={t("drive.storage.usedPercent", {
                        percent: Math.round(storagePercent(root)),
                      })}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(storagePercent(root))}
                    >
                      <span
                        className="bg-primary block h-full rounded-full"
                        style={{ width: `${storagePercent(root)}%` }}
                      />
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function DirectoryPage({
  listing,
  loading,
  selectionMode,
  selectedPaths,
  pinnedPaths,
  onOpenEntry,
  onDownload,
  onCopy,
  onMove,
  onRun,
  onPinToggle,
  onRename,
  onDelete,
  onSelectAll,
  onToggleSelection,
}: {
  listing: DirectoryListing | null
  loading: boolean
  selectionMode: boolean
  selectedPaths: Set<string>
  pinnedPaths: Set<string>
  onOpenEntry: (entry: FileEntry) => void
  onDownload: (entry: FileEntry) => void
  onCopy: (entries: FileEntry[]) => void
  onMove: (entries: FileEntry[]) => void
  onRun: (entry: FileEntry) => void
  onPinToggle: (path: string) => void
  onRename: (entry: FileEntry) => void
  onDelete: (entry: FileEntry) => void
  onSelectAll: (checked: boolean) => void
  onToggleSelection: (path: string, checked: boolean) => void
}) {
  const { t } = useTranslation()
  const {
    hiddenCount,
    showMore,
    visibleItems: visibleEntries,
  } = useIncrementalList({
    items: listing?.entries ?? [],
    initialCount: 200,
    step: 200,
    resetKey: listing?.path ?? "empty",
  })

  if (loading) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        {t("labels.loading")}
      </div>
    )
  }

  if (!listing) return null

  if (listing.entries.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        {t("drive.empty")}
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div
        className={cn(
          "text-muted-foreground border-border bg-card/95 sticky top-0 z-10 grid h-9 items-center border-b px-4 text-xs font-medium",
          selectionMode
            ? "grid-cols-[2.25rem_minmax(12rem,1fr)_7rem_10rem_3rem] max-lg:grid-cols-[2.25rem_minmax(10rem,1fr)_6rem_3rem]"
            : "grid-cols-[minmax(12rem,1fr)_7rem_10rem_3rem] max-lg:grid-cols-[minmax(10rem,1fr)_6rem_3rem]",
        )}
      >
        {selectionMode && (
          <input
            type="checkbox"
            aria-label={t("drive.actions.selectAll")}
            checked={
              listing.entries.length > 0 &&
              listing.entries.every((entry) => selectedPaths.has(entry.path))
            }
            onChange={(event) => onSelectAll(event.target.checked)}
            className="size-4 accent-current"
          />
        )}
        <div>{t("drive.columns.name")}</div>
        <div className="max-lg:hidden">{t("drive.columns.size")}</div>
        <div>{t("drive.columns.modified")}</div>
        <div className="text-right">{t("drive.columns.more")}</div>
      </div>
      {visibleEntries.map((entry) => {
        const selected = selectedPaths.has(entry.path)
        const pinned = pinnedPaths.has(entry.path)
        return (
          <div
            key={entry.path}
            data-selected={selectionMode && selected}
            className={cn(
              "hover:bg-accent/70 data-[selected=true]:bg-accent/80 border-border/65 grid min-h-11 w-full items-center gap-2 border-b px-4 text-left text-sm transition-colors",
              selectionMode
                ? "grid-cols-[2.25rem_minmax(12rem,1fr)_7rem_10rem_3rem] max-lg:grid-cols-[2.25rem_minmax(10rem,1fr)_6rem_3rem]"
                : "grid-cols-[minmax(12rem,1fr)_7rem_10rem_3rem] max-lg:grid-cols-[minmax(10rem,1fr)_6rem_3rem]",
            )}
          >
            {selectionMode && (
              <input
                type="checkbox"
                aria-label={`Select ${entry.name}`}
                checked={selected}
                onChange={(event) =>
                  onToggleSelection(entry.path, event.target.checked)
                }
                className="size-4 accent-current"
              />
            )}
            <button
              type="button"
              onClick={() => onOpenEntry(entry)}
              className="focus-visible:ring-ring/30 focus-visible:bg-accent flex min-w-0 items-center gap-2 rounded-md text-left focus-visible:ring-2 focus-visible:outline-none"
            >
              <EntryIcon entry={entry} />
              <span className="min-w-0 truncate font-medium">{entry.name}</span>
            </button>
            <span className="text-muted-foreground truncate text-xs max-lg:hidden">
              {entry.type === "file" ? formatFileSize(entry.sizeBytes) : ""}
            </span>
            <span className="text-muted-foreground truncate text-xs">
              {formatDate(entry.modifiedAt)}
            </span>
            <div className="flex justify-end">
              <DropdownMenu>
                <MenuButton label={`${entry.name} actions`} />
                <DropdownMenuContent
                  align="end"
                  sideOffset={2}
                  className="w-32 rounded-md p-0.5"
                >
                  <DropdownMenuItem
                    onSelect={() => onOpenEntry(entry)}
                    className="h-7 gap-2 rounded-sm px-1.5 py-1 text-xs"
                  >
                    <IconFile className="size-3.5" />
                    {t("drive.actions.open")}
                  </DropdownMenuItem>
                  {entry.type === "file" && (
                    <DropdownMenuItem
                      onSelect={() => onRun(entry)}
                      className="h-7 gap-2 rounded-sm px-1.5 py-1 text-xs"
                    >
                      <IconPlayerPlay className="size-3.5" />
                      {t("drive.actions.run")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onSelect={() => onCopy([entry])}
                    className="h-7 gap-2 rounded-sm px-1.5 py-1 text-xs"
                  >
                    <IconCopy className="size-3.5" />
                    {t("drive.actions.copy")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => onMove([entry])}
                    className="h-7 gap-2 rounded-sm px-1.5 py-1 text-xs"
                  >
                    <IconScissors className="size-3.5" />
                    {t("drive.actions.move")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => onPinToggle(entry.path)}
                    className="h-7 gap-2 rounded-sm px-1.5 py-1 text-xs"
                  >
                    {pinned ? (
                      <IconPinnedOff className="size-3.5" />
                    ) : (
                      <IconPinned className="size-3.5" />
                    )}
                    {pinned ? t("drive.actions.unpin") : t("drive.actions.pin")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => onDownload(entry)}
                    className="h-7 gap-2 rounded-sm px-1.5 py-1 text-xs"
                  >
                    <IconDownload className="size-3.5" />
                    {t("drive.actions.download")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => onRename(entry)}
                    className="h-7 gap-2 rounded-sm px-1.5 py-1 text-xs"
                  >
                    <IconPencil className="size-3.5" />
                    {t("drive.actions.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => onDelete(entry)}
                    className="h-7 gap-2 rounded-sm px-1.5 py-1 text-xs"
                  >
                    <IconTrash className="size-3.5" />
                    {t("drive.actions.delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )
      })}
      {hiddenCount > 0 && (
        <div className="border-border/65 flex justify-center border-b px-4 py-3">
          <Button variant="outline" size="sm" onClick={showMore}>
            {t("common.showMore", { count: hiddenCount })}
          </Button>
        </div>
      )}
    </div>
  )
}

function ImagePreview({ path }: { path: string }) {
  const { t } = useTranslation()
  const [objectUrl, setObjectUrl] = React.useState("")
  const [error, setError] = React.useState("")

  React.useEffect(() => {
    let cancelled = false
    let nextObjectUrl = ""

    setObjectUrl("")
    setError("")

    void launcherFetch(previewFileUrl(path))
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string
          }
          throw new Error(body.error || `Preview failed: ${response.status}`)
        }
        return response.blob()
      })
      .then((blob) => {
        if (cancelled) return
        nextObjectUrl = URL.createObjectURL(blob)
        setObjectUrl(nextObjectUrl)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(errorMessage(err))
      })

    return () => {
      cancelled = true
      if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl)
    }
  }, [path])

  if (error) {
    return (
      <div className="text-muted-foreground flex max-w-sm flex-col items-center gap-3 text-center text-sm">
        <IconPhoto className="size-8 opacity-70" />
        <span>{error}</span>
        <Button asChild variant="outline" size="sm">
          <a href={downloadFileUrl(path)}>
            <IconDownload className="size-4" />
            {t("drive.actions.download")}
          </a>
        </Button>
      </div>
    )
  }

  if (!objectUrl) {
    return (
      <div className="text-muted-foreground text-sm">
        {t("drive.preview.loading")}
      </div>
    )
  }

  return (
    <img
      src={objectUrl}
      alt={basename(path)}
      width={1280}
      height={720}
      className="aspect-video max-h-full max-w-full object-contain"
    />
  )
}

function FilePage({
  path,
  file,
  draft,
  loading,
  saving,
  error,
  onDraftChange,
  onSave,
}: {
  path: string
  file: ReadFileResponse | null
  draft: string
  loading: boolean
  saving: boolean
  error: string
  onDraftChange: (value: string) => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  const kind = previewKind(path)
  const [viewMode, setViewMode] = React.useState<"raw" | "preview">("preview")

  React.useEffect(() => {
    setViewMode("preview")
  }, [path])

  if (loading) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        {t("labels.loading")}
      </div>
    )
  }

  if (usesInlineStream(kind)) {
    const url = previewFileUrl(path)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-border text-muted-foreground flex h-10 shrink-0 items-center justify-between border-b px-4 text-xs">
          <span className="truncate">
            {t("drive.preview.kind", { kind: kind.toUpperCase() })}
          </span>
          <Button asChild variant="outline" size="sm">
            <a href={downloadFileUrl(path)}>
              <IconDownload className="size-4" />
              {t("drive.actions.download")}
            </a>
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          {kind === "image" && <ImagePreview path={path} />}
          {kind === "pdf" && (
            <iframe
              src={url}
              title={basename(path)}
              className="border-border bg-background h-full w-full rounded-md border"
            />
          )}
          {kind === "audio" && (
            <audio controls src={url} className="w-full max-w-xl" />
          )}
          {kind === "video" && (
            <video
              controls
              src={url}
              className="max-h-full max-w-full rounded-md"
            />
          )}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-muted-foreground max-w-sm text-sm">{error}</p>
        <Button asChild variant="outline" size="sm">
          <a href={downloadFileUrl(path)}>
            <IconDownload className="size-4" />
            {t("drive.actions.download")}
          </a>
        </Button>
      </div>
    )
  }

  if (!file) return null

  const richPreview = RichTextPreview({ path, content: draft, kind })
  const showPreview = Boolean(richPreview && viewMode === "preview")

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border text-muted-foreground flex h-10 shrink-0 items-center justify-between border-b px-4 text-xs">
        <span>
          {formatFileSize(file.sizeBytes)}
          {richPreview ? ` / ${t("drive.preview.kind", { kind })}` : ""}
        </span>
        <div className="flex items-center gap-2">
          {richPreview && (
            <div className="border-border bg-muted/40 flex h-8 overflow-hidden rounded-md border p-0.5">
              <button
                type="button"
                onClick={() => setViewMode("raw")}
                data-active={viewMode === "raw"}
                aria-pressed={viewMode === "raw"}
                className="data-[active=true]:bg-background data-[active=true]:text-foreground text-muted-foreground hover:text-foreground focus-visible:ring-ring/30 rounded px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                {t("drive.preview.raw")}
              </button>
              <button
                type="button"
                onClick={() => setViewMode("preview")}
                data-active={viewMode === "preview"}
                aria-pressed={viewMode === "preview"}
                className="data-[active=true]:bg-background data-[active=true]:text-foreground text-muted-foreground hover:text-foreground focus-visible:ring-ring/30 rounded px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                {t("drive.preview.preview")}
              </button>
            </div>
          )}
          <Button
            type="button"
            size="sm"
            disabled={saving || file.readonly}
            onClick={onSave}
          >
            <IconDeviceFloppy className="size-4" />
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </div>
      {showPreview ? (
        <div className="bg-card/40 min-h-0 flex-1 overflow-hidden">
          {richPreview}
        </div>
      ) : (
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          spellCheck={false}
          className="text-foreground focus-visible:ring-ring/30 min-h-0 flex-1 resize-none border-0 bg-transparent p-4 font-mono text-[13px] leading-6 outline-none focus-visible:ring-2"
          aria-label={`${basename(path)} content`}
        />
      )}
    </div>
  )
}

export function DrivePage() {
  const { t } = useTranslation()
  const [page, setPage] = React.useState<ExplorerPage>(() => pageFromLocation())
  const [roots, setRoots] = React.useState<FileRoot[]>([])
  const [listing, setListing] = React.useState<DirectoryListing | null>(null)
  const [activeFile, setActiveFile] = React.useState<ReadFileResponse | null>(
    null,
  )
  const [draft, setDraft] = React.useState("")
  const initialPathInput =
    page.kind === "system" ? t("drive.system") : page.path
  const [pathInput, setPathInput] = React.useState(initialPathInput)
  const [loadingRoots, setLoadingRoots] = React.useState(true)
  const [loadingDirectory, setLoadingDirectory] = React.useState(false)
  const [loadingFile, setLoadingFile] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const [fileError, setFileError] = React.useState("")
  const [statusMessage, setStatusMessage] = React.useState<{
    kind: "success" | "error"
    text: string
  } | null>(null)
  const [pinnedPaths, setPinnedPaths] = React.useState<Set<string>>(
    () => new Set(readPinnedPaths()),
  )
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(
    () => new Set(),
  )
  const [selectionMode, setSelectionMode] = React.useState(false)
  const [undoStack, setUndoStack] = React.useState<ExplorerOperation[]>([])
  const [redoStack, setRedoStack] = React.useState<ExplorerOperation[]>([])
  const [textDialog, setTextDialog] =
    React.useState<DriveTextDialogState | null>(null)
  const [textDialogValue, setTextDialogValue] = React.useState("")
  const [deleteDialog, setDeleteDialog] =
    React.useState<DriveDeleteDialogState>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const pinnedRoots = React.useMemo<FileRoot[]>(
    () =>
      Array.from(pinnedPaths).map((pinPath, index) => ({
        id: `pinned-${index}`,
        label: basename(pinPath),
        path: pinPath,
        kind: "quickAccess",
        protected: false,
      })),
    [pinnedPaths],
  )
  const groups = React.useMemo(
    () => rootGroups([...pinnedRoots, ...roots], t),
    [pinnedRoots, roots, t],
  )

  const pushOperation = React.useCallback((operation: ExplorerOperation) => {
    setUndoStack((current) => [...current, operation].slice(-50))
    setRedoStack([])
  }, [])

  const navigatePage = React.useCallback(
    (nextPage: ExplorerPage) => {
      if (!samePage(pageFromLocation(), nextPage)) {
        window.history.pushState(null, "", pageUrl(nextPage))
      }
      setPage(nextPage)
      setPathInput(
        nextPage.kind === "system" ? t("drive.system") : nextPage.path,
      )
      setError("")
      setStatusMessage(null)
    },
    [t],
  )

  const openSystem = React.useCallback(() => {
    navigatePage({ kind: "system" })
  }, [navigatePage])

  const openDirectory = React.useCallback(
    (path: string) => {
      navigatePage({ kind: "directory", path })
    },
    [navigatePage],
  )

  const openFile = React.useCallback(
    (path: string) => {
      navigatePage({ kind: "file", path })
    },
    [navigatePage],
  )

  React.useEffect(() => {
    const onPopState = () => {
      const nextPage = pageFromLocation()
      setPage(nextPage)
      setPathInput(
        nextPage.kind === "system" ? t("drive.system") : nextPage.path,
      )
      setError("")
      setStatusMessage(null)
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [t])

  React.useEffect(() => {
    let cancelled = false
    setLoadingRoots(true)
    getFileRoots()
      .then((response) => {
        if (!cancelled) setRoots(response.roots)
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingRoots(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    if (page.kind !== "system") return

    const interval = window.setInterval(() => {
      getFileRoots()
        .then((response) => setRoots(response.roots))
        .catch((err) => setError(errorMessage(err)))
    }, 10_000)

    return () => window.clearInterval(interval)
  }, [page.kind])

  React.useEffect(() => {
    if (page.kind !== "directory") return

    let cancelled = false
    setLoadingDirectory(true)
    setListing(null)
    setSelectedPaths(new Set())
    setSelectionMode(false)
    setError("")
    listFiles(page.path)
      .then((response) => {
        if (!cancelled) {
          setListing(response)
          setPathInput(response.path)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingDirectory(false)
      })

    return () => {
      cancelled = true
    }
  }, [page])

  React.useEffect(() => {
    if (page.kind !== "file") return

    if (usesInlineStream(previewKind(page.path))) {
      setLoadingFile(false)
      setActiveFile(null)
      setDraft("")
      setFileError("")
      setError("")
      setPathInput(page.path)
      return
    }

    let cancelled = false
    setLoadingFile(true)
    setActiveFile(null)
    setDraft("")
    setFileError("")
    setError("")
    readFile(page.path)
      .then((response) => {
        if (!cancelled) {
          setActiveFile(response)
          setDraft(response.content)
          setPathInput(response.path)
        }
      })
      .catch((err) => {
        if (!cancelled) setFileError(errorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingFile(false)
      })

    return () => {
      cancelled = true
    }
  }, [page])

  const refreshCurrentPage = React.useCallback(() => {
    if (page.kind === "system") {
      setLoadingRoots(true)
      getFileRoots()
        .then((response) => setRoots(response.roots))
        .catch((err) => setError(errorMessage(err)))
        .finally(() => setLoadingRoots(false))
      return
    }
    setPage({ ...page })
  }, [page])

  const submitPath = React.useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      const nextPath = pathInput.trim()
      if (
        !nextPath ||
        nextPath.toLowerCase() === "system" ||
        nextPath.toLowerCase() === t("drive.system").toLowerCase()
      ) {
        openSystem()
        return
      }

      setError("")
      try {
        await listFiles(nextPath)
        openDirectory(nextPath)
      } catch (directoryError) {
        try {
          await readFile(nextPath)
          openFile(nextPath)
        } catch {
          setError(errorMessage(directoryError))
        }
      }
    },
    [openDirectory, openFile, openSystem, pathInput, t],
  )

  const announceSuccess = React.useCallback((message: string) => {
    setStatusMessage({ kind: "success", text: message })
    toast.success(message)
  }, [])

  const announceError = React.useCallback((message: string) => {
    setStatusMessage({ kind: "error", text: message })
    toast.error(message)
  }, [])

  const togglePin = React.useCallback(
    (targetPath: string) => {
      setPinnedPaths((current) => {
        const next = new Set(current)
        if (next.has(targetPath)) {
          next.delete(targetPath)
          announceSuccess(t("drive.toast.unpinned"))
        } else {
          next.add(targetPath)
          announceSuccess(t("drive.toast.pinned"))
        }
        writePinnedPaths(Array.from(next))
        return next
      })
    },
    [announceSuccess, t],
  )

  const toggleSelection = React.useCallback(
    (targetPath: string, checked: boolean) => {
      setSelectionMode(true)
      setSelectedPaths((current) => {
        const next = new Set(current)
        if (checked) next.add(targetPath)
        else next.delete(targetPath)
        return next
      })
    },
    [],
  )

  const selectAll = React.useCallback(
    (checked: boolean) => {
      if (!listing) return
      setSelectionMode(checked)
      setSelectedPaths(
        checked
          ? new Set(listing.entries.map((entry) => entry.path))
          : new Set(),
      )
    },
    [listing],
  )

  const startSelection = React.useCallback(() => {
    setSelectionMode(true)
  }, [])

  const clearSelection = React.useCallback(() => {
    setSelectedPaths(new Set())
    setSelectionMode(false)
  }, [])

  const selectedEntries = React.useMemo(() => {
    if (!listing) return []
    return listing.entries.filter((entry) => selectedPaths.has(entry.path))
  }, [listing, selectedPaths])

  const openTextDialog = React.useCallback((dialog: DriveTextDialogState) => {
    setTextDialog(dialog)
    if (dialog.kind === "create") {
      setTextDialogValue("")
      return
    }
    if (dialog.kind === "rename") {
      setTextDialogValue(dialog.entry.name)
      return
    }
    setTextDialogValue(dialog.destinationPath)
  }, [])

  const copyEntries = React.useCallback(
    (entries: FileEntry[]) => {
      if (entries.length === 0) return
      openTextDialog({
        kind: "copy",
        entries,
        destinationPath: page.kind === "directory" ? page.path : "",
      })
    },
    [openTextDialog, page],
  )

  const moveEntries = React.useCallback(
    (entries: FileEntry[]) => {
      if (entries.length === 0) return
      openTextDialog({
        kind: "move",
        entries,
        destinationPath: page.kind === "directory" ? page.path : "",
      })
    },
    [openTextDialog, page],
  )

  const runEntry = React.useCallback(
    async (entry: FileEntry) => {
      if (entry.type !== "file") return
      try {
        await runFileItem(entry.path)
        announceSuccess(t("drive.toast.runRequested"))
      } catch (err) {
        announceError(errorMessage(err))
      }
    },
    [announceError, announceSuccess, t],
  )

  const downloadEntries = React.useCallback((entries: FileEntry[]) => {
    const paths = entries.map((entry) => entry.path)
    if (paths.length === 0) return
    if (entries.length === 1 && entries[0].type === "file") {
      window.location.assign(downloadFileUrl(entries[0].path))
      return
    }
    window.location.assign(downloadArchiveUrl(paths))
  }, [])

  const createItem = React.useCallback(
    (type: "file" | "directory") => {
      if (page.kind !== "directory") return
      openTextDialog({ kind: "create", itemType: type, parentPath: page.path })
    },
    [openTextDialog, page],
  )

  const renameEntry = React.useCallback(
    (entry: FileEntry) => {
      openTextDialog({ kind: "rename", entry })
    },
    [openTextDialog],
  )

  const deleteEntry = React.useCallback((entry: FileEntry) => {
    setDeleteDialog({ entries: [entry] })
  }, [])

  const deleteEntries = React.useCallback((entries: FileEntry[]) => {
    if (entries.length === 0) return
    setDeleteDialog({ entries })
  }, [])

  const submitTextDialog = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!textDialog) return

      const value = textDialogValue.trim()
      if (!value) return

      try {
        switch (textDialog.kind) {
          case "create": {
            await createFileItem({
              parentPath: textDialog.parentPath,
              name: value,
              type: textDialog.itemType,
              content: "",
            })
            pushOperation({
              kind: "create",
              path: joinPath(textDialog.parentPath, value),
              itemType: textDialog.itemType,
            })
            refreshCurrentPage()
            announceSuccess(
              textDialog.itemType === "file"
                ? t("drive.toast.fileCreated")
                : t("drive.toast.folderCreated"),
            )
            break
          }
          case "rename": {
            if (value === textDialog.entry.name) {
              setTextDialog(null)
              return
            }
            const response = await renameFileItem(textDialog.entry.path, value)
            pushOperation({
              kind: "rename",
              oldPath: textDialog.entry.path,
              newPath: response.entry.path,
            })
            refreshCurrentPage()
            announceSuccess(t("drive.toast.renamed"))
            break
          }
          case "copy": {
            const paths = textDialog.entries.map((entry) => entry.path)
            const response = await copyFileItems(paths, value)
            pushOperation({
              kind: "copy",
              sourcePaths: paths,
              destinationPath: value,
              copiedPaths: response.entries.map((entry) => entry.path),
            })
            refreshCurrentPage()
            announceSuccess(t("drive.toast.copied"))
            break
          }
          case "move": {
            const paths = textDialog.entries.map((entry) => entry.path)
            const response = await moveFileItems(paths, value)
            pushOperation({
              kind: "move",
              sourcePaths: paths,
              movedPaths: response.entries.map((entry) => entry.path),
            })
            clearSelection()
            refreshCurrentPage()
            announceSuccess(t("drive.toast.moved"))
            break
          }
        }
        setTextDialog(null)
      } catch (err) {
        announceError(errorMessage(err))
      }
    },
    [
      announceError,
      announceSuccess,
      clearSelection,
      pushOperation,
      refreshCurrentPage,
      t,
      textDialog,
      textDialogValue,
    ],
  )

  const confirmDeleteDialog = React.useCallback(async () => {
    if (!deleteDialog) return
    const { entries } = deleteDialog

    try {
      for (const entry of entries) {
        await deleteFileItem(entry.path, entry.type === "directory")
      }
      setSelectedPaths(new Set())
      setDeleteDialog(null)
      refreshCurrentPage()
      announceSuccess(
        entries.length === 1
          ? t("drive.toast.deleted")
          : t("drive.toast.deletedSelected"),
      )
    } catch (err) {
      refreshCurrentPage()
      announceError(errorMessage(err))
    }
  }, [announceError, announceSuccess, deleteDialog, refreshCurrentPage, t])

  const applyUndo = React.useCallback(async (operation: ExplorerOperation) => {
    switch (operation.kind) {
      case "create":
        await deleteFileItem(operation.path, operation.itemType === "directory")
        break
      case "rename":
        await renameFileItem(operation.newPath, basename(operation.oldPath))
        break
      case "copy":
        for (const copiedPath of operation.copiedPaths) {
          await deleteFileItem(copiedPath, true)
        }
        break
      case "move":
        for (let index = 0; index < operation.movedPaths.length; index += 1) {
          const movedPath = operation.movedPaths[index]
          const sourcePath = operation.sourcePaths[index]
          if (movedPath && sourcePath) {
            await moveFileItems([movedPath], directoryName(sourcePath))
          }
        }
        break
    }
  }, [])

  const applyRedo = React.useCallback(async (operation: ExplorerOperation) => {
    switch (operation.kind) {
      case "create":
        await createFileItem({
          parentPath: directoryName(operation.path),
          name: basename(operation.path),
          type: operation.itemType,
          content: "",
        })
        break
      case "rename":
        await renameFileItem(operation.oldPath, basename(operation.newPath))
        break
      case "copy":
        await copyFileItems(operation.sourcePaths, operation.destinationPath)
        break
      case "move":
        await moveFileItems(
          operation.sourcePaths,
          directoryName(operation.movedPaths[0] || ""),
        )
        break
    }
  }, [])

  const undoLastOperation = React.useCallback(async () => {
    const operation = undoStack.at(-1)
    if (!operation) return
    try {
      await applyUndo(operation)
      setUndoStack((current) => current.slice(0, -1))
      setRedoStack((current) => [...current, operation])
      refreshCurrentPage()
      announceSuccess(t("drive.toast.undone"))
    } catch (err) {
      announceError(errorMessage(err))
    }
  }, [
    announceError,
    announceSuccess,
    applyUndo,
    refreshCurrentPage,
    t,
    undoStack,
  ])

  const redoLastOperation = React.useCallback(async () => {
    const operation = redoStack.at(-1)
    if (!operation) return
    try {
      await applyRedo(operation)
      setRedoStack((current) => current.slice(0, -1))
      setUndoStack((current) => [...current, operation])
      refreshCurrentPage()
      announceSuccess(t("drive.toast.redone"))
    } catch (err) {
      announceError(errorMessage(err))
    }
  }, [
    announceError,
    announceSuccess,
    applyRedo,
    redoStack,
    refreshCurrentPage,
    t,
  ])

  const saveActiveFile = React.useCallback(async () => {
    if (!activeFile) return
    setSaving(true)
    try {
      const response = await writeFile(
        activeFile.path,
        draft,
        activeFile.modifiedAt,
      )
      setActiveFile({
        ...activeFile,
        content: draft,
        modifiedAt: response.entry.modifiedAt,
        readonly: response.entry.readonly,
        sizeBytes: response.entry.sizeBytes,
      })
      announceSuccess(t("drive.toast.saved"))
    } catch (err) {
      announceError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [activeFile, announceError, announceSuccess, draft, t])

  const uploadSelectedFile = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ""
      if (!file || page.kind !== "directory") return
      try {
        await uploadFile(page.path, file)
        refreshCurrentPage()
        announceSuccess(t("drive.toast.uploaded"))
      } catch (err) {
        announceError(errorMessage(err))
      }
    },
    [announceError, announceSuccess, page, refreshCurrentPage, t],
  )

  const goUp = React.useCallback(() => {
    if (page.kind === "directory") {
      if (listing?.parentPath) {
        openDirectory(listing.parentPath)
      } else {
        openSystem()
      }
      return
    }
    if (page.kind === "file") {
      const parent = activeFile?.path
        ? activeFile.path.replace(/[\\/][^\\/]*$/, "")
        : page.path.replace(/[\\/][^\\/]*$/, "")
      if (parent && parent !== page.path) {
        openDirectory(parent)
      } else {
        openSystem()
      }
    }
  }, [activeFile, listing, openDirectory, openSystem, page])

  const textDialogCopy = React.useMemo(() => {
    if (!textDialog) {
      return null
    }

    switch (textDialog.kind) {
      case "create": {
        const label =
          textDialog.itemType === "file"
            ? t("drive.item.file")
            : t("drive.item.folder")
        return {
          title: t("drive.dialog.createTitle", { item: label }),
          description: t("drive.dialog.createDescription", { item: label }),
          label: t("drive.dialog.createLabel", { item: label }),
          submitLabel: t("drive.actions.create"),
        }
      }
      case "rename":
        return {
          title: t("drive.dialog.renameTitle"),
          description: t("drive.dialog.renameDescription", {
            name: textDialog.entry.name,
          }),
          label: t("drive.dialog.renameLabel"),
          submitLabel: t("drive.actions.rename"),
        }
      case "copy":
        return {
          title:
            textDialog.entries.length === 1
              ? t("drive.dialog.copyTitle")
              : t("drive.dialog.copyManyTitle", {
                  count: textDialog.entries.length,
                }),
          description: t("drive.dialog.copyDescription"),
          label: t("drive.dialog.destinationLabel"),
          submitLabel: t("drive.actions.copy"),
        }
      case "move":
        return {
          title:
            textDialog.entries.length === 1
              ? t("drive.dialog.moveTitle")
              : t("drive.dialog.moveManyTitle", {
                  count: textDialog.entries.length,
                }),
          description: t("drive.dialog.moveDescription"),
          label: t("drive.dialog.destinationLabel"),
          submitLabel: t("drive.actions.move"),
        }
    }
  }, [t, textDialog])

  const deleteDialogPreview = React.useMemo(() => {
    if (!deleteDialog) {
      return ""
    }

    const previewNames = deleteDialog.entries
      .slice(0, 5)
      .map((entry) => `- ${entry.name}`)
      .join("\n")
    const remainingCount = deleteDialog.entries.length - 5
    const remainingText =
      remainingCount > 0
        ? `\n${t("drive.dialog.andMore", { count: remainingCount })}`
        : ""
    return `${previewNames}${remainingText}`
  }, [deleteDialog, t])

  const title =
    page.kind === "system"
      ? t("drive.system")
      : page.kind === "file"
        ? basename(page.path)
        : page.path

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="border-border bg-card/80 flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger
          className="size-8 shrink-0 rounded-md md:hidden"
          aria-label={t("navigation.toggle_sidebar")}
          title={t("navigation.toggle_sidebar")}
        />
        <h1 className="max-w-[min(42vw,24rem)] min-w-0 shrink truncate text-lg font-semibold">
          {page.kind === "system" ? t("drive.system") : basename(title)}
        </h1>
        <form onSubmit={submitPath} className="min-w-[5.5rem] flex-1">
          <Input
            name="path"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            className="h-9 font-mono text-sm"
            aria-label={t("drive.path")}
            autoComplete="off"
          />
        </form>
        <ToolButton
          label={t("drive.system")}
          disabled={page.kind === "system"}
          onClick={openSystem}
        >
          <IconArrowLeft className="size-4" />
        </ToolButton>
        <ToolButton
          label={t("drive.actions.up")}
          disabled={page.kind === "system"}
          onClick={goUp}
        >
          <IconArrowUp className="size-4" />
        </ToolButton>
        <ToolButton label={t("common.refresh")} onClick={refreshCurrentPage}>
          <IconRefresh className="size-4" />
        </ToolButton>
        <DropdownMenu>
          <MenuButton label={t("drive.actions.label")} />
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>
              {selectedEntries.length > 0
                ? t("drive.selection.selected", {
                    count: selectedEntries.length,
                  })
                : t("drive.actions.label")}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={undoStack.length === 0}
              onSelect={() => void undoLastOperation()}
            >
              <IconArrowBackUp className="size-4" />
              {t("drive.actions.undo")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={redoStack.length === 0}
              onSelect={() => void redoLastOperation()}
            >
              <IconArrowForwardUp className="size-4" />
              {t("drive.actions.redo")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {page.kind === "directory" && (
              <>
                <DropdownMenuItem onSelect={() => void createItem("file")}>
                  <IconFilePlus className="size-4" />
                  {t("drive.actions.createFile")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void createItem("directory")}>
                  <IconFolderPlus className="size-4" />
                  {t("drive.actions.createFolder")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => fileInputRef.current?.click()}
                >
                  <IconUpload className="size-4" />
                  {t("drive.actions.upload")}
                </DropdownMenuItem>
                {!selectionMode ? (
                  <DropdownMenuItem onSelect={startSelection}>
                    <IconChecks className="size-4" />
                    {t("drive.actions.select")}
                  </DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuItem onSelect={() => selectAll(true)}>
                      <IconChecks className="size-4" />
                      {t("drive.actions.selectAll")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={clearSelection}>
                      <IconChecks className="size-4" />
                      {t("drive.actions.clearSelection")}
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => togglePin(page.path)}>
                  {pinnedPaths.has(page.path) ? (
                    <IconPinnedOff className="size-4" />
                  ) : (
                    <IconPinned className="size-4" />
                  )}
                  {pinnedPaths.has(page.path)
                    ? t("drive.actions.unpinFolder")
                    : t("drive.actions.pinFolder")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={selectedEntries.length === 0}
                  onSelect={() => downloadEntries(selectedEntries)}
                >
                  <IconDownload className="size-4" />
                  {t("drive.actions.downloadSelected")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={selectedEntries.length === 0}
                  onSelect={() => void copyEntries(selectedEntries)}
                >
                  <IconCopy className="size-4" />
                  {t("drive.actions.copySelected")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={selectedEntries.length === 0}
                  onSelect={() => void moveEntries(selectedEntries)}
                >
                  <IconScissors className="size-4" />
                  {t("drive.actions.moveSelected")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={selectedEntries.length === 0}
                  variant="destructive"
                  onSelect={() => {
                    void deleteEntries(selectedEntries)
                  }}
                >
                  <IconTrash className="size-4" />
                  {t("drive.actions.deleteSelected")}
                </DropdownMenuItem>
              </>
            )}
            {page.kind === "file" && (
              <>
                <DropdownMenuItem
                  onSelect={() =>
                    void runEntry({
                      name: basename(page.path),
                      path: page.path,
                      type: "file",
                      sizeBytes: activeFile?.sizeBytes || 0,
                      modifiedAt:
                        activeFile?.modifiedAt || new Date().toISOString(),
                      extension: "",
                      hidden: false,
                      readonly: activeFile?.readonly || false,
                    })
                  }
                >
                  <IconPlayerPlay className="size-4" />
                  {t("drive.actions.run")}
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={downloadFileUrl(page.path)}>
                    <IconDownload className="size-4" />
                    {t("drive.actions.download")}
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => togglePin(page.path)}>
                  {pinnedPaths.has(page.path) ? (
                    <IconPinnedOff className="size-4" />
                  ) : (
                    <IconPinned className="size-4" />
                  )}
                  {pinnedPaths.has(page.path)
                    ? t("drive.actions.unpin")
                    : t("drive.actions.pin")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          ref={fileInputRef}
          type="file"
          aria-label={t("drive.actions.uploadFile")}
          className="hidden"
          onChange={uploadSelectedFile}
        />
      </header>

      {error && (
        <div
          className="border-border bg-destructive/10 text-destructive shrink-0 border-b px-3 py-2 text-sm"
          role="alert"
        >
          {error}
        </div>
      )}

      {statusMessage && (
        <div
          className={
            statusMessage.kind === "error"
              ? "border-border bg-destructive/10 text-destructive shrink-0 border-b px-3 py-2 text-sm"
              : "border-border bg-muted/60 text-foreground shrink-0 border-b px-3 py-2 text-sm"
          }
          role={statusMessage.kind === "error" ? "alert" : "status"}
          aria-live={statusMessage.kind === "error" ? "assertive" : "polite"}
        >
          {statusMessage.text}
        </div>
      )}

      {page.kind === "system" && (
        <SystemPage
          groups={groups}
          loading={loadingRoots}
          onOpenRoot={(root) => openDirectory(root.path)}
        />
      )}

      {page.kind === "directory" && (
        <DirectoryPage
          listing={listing}
          loading={loadingDirectory}
          selectionMode={selectionMode}
          selectedPaths={selectedPaths}
          pinnedPaths={pinnedPaths}
          onOpenEntry={(entry) => {
            if (entry.type === "directory") {
              openDirectory(entry.path)
            } else {
              openFile(entry.path)
            }
          }}
          onDownload={(entry) => downloadEntries([entry])}
          onCopy={(entries) => void copyEntries(entries)}
          onMove={(entries) => void moveEntries(entries)}
          onRun={(entry) => void runEntry(entry)}
          onPinToggle={togglePin}
          onRename={renameEntry}
          onDelete={deleteEntry}
          onSelectAll={selectAll}
          onToggleSelection={toggleSelection}
        />
      )}

      {page.kind === "file" && (
        <FilePage
          path={page.path}
          file={activeFile}
          draft={draft}
          loading={loadingFile}
          saving={saving}
          error={fileError}
          onDraftChange={setDraft}
          onSave={() => void saveActiveFile()}
        />
      )}

      <Dialog
        open={Boolean(textDialog)}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setTextDialog(null)
          }
        }}
      >
        <DialogContent>
          <form onSubmit={submitTextDialog} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>{textDialogCopy?.title}</DialogTitle>
              <DialogDescription>
                {textDialogCopy?.description}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <label
                htmlFor="drive-operation-value"
                className="text-sm font-medium"
              >
                {textDialogCopy?.label}
              </label>
              <Input
                id="drive-operation-value"
                name="drive_operation_value"
                value={textDialogValue}
                onChange={(event) => setTextDialogValue(event.target.value)}
                autoComplete="off"
                required
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setTextDialog(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!textDialogValue.trim()}>
                {textDialogCopy?.submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteDialog)}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setDeleteDialog(null)
          }
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteDialog?.entries.length === 1
                ? t("drive.dialog.deleteOneTitle", {
                    name: deleteDialog.entries[0].name,
                  })
                : t("drive.dialog.deleteManyTitle", {
                    count: deleteDialog?.entries.length ?? 0,
                  })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("drive.dialog.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteDialogPreview && (
            <pre className="bg-muted/50 text-muted-foreground max-h-40 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
              {deleteDialogPreview}
            </pre>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void confirmDeleteDialog()}
            >
              {t("drive.actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
