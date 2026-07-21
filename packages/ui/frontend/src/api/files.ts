import { launcherFetch } from "@/api/http"

export class FilesApiError extends Error {
  public readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "FilesApiError"
    this.status = status
  }
}

export type FileEntryType = "file" | "directory" | "symlink"

export interface FileRoot {
  id: string
  label: string
  path: string
  kind: "home" | "workspace" | "drive" | "root" | "quickAccess"
  protected: boolean
  storage?: FileRootStorage
}

export interface FileRootStorage {
  totalBytes: number
  freeBytes: number
  usedBytes: number
}

export interface FileEntry {
  name: string
  path: string
  type: FileEntryType
  sizeBytes: number
  modifiedAt: string
  extension: string
  hidden: boolean
  readonly: boolean
}

export interface DirectoryListing {
  path: string
  parentPath: string | null
  entries: FileEntry[]
  limit: number
}

export interface ReadFileResponse {
  path: string
  content: string
  sizeBytes: number
  modifiedAt: string
  readonly: boolean
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await launcherFetch(path, options)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new FilesApiError(body.error || `API error: ${res.status}`, res.status)
  }
  return res.json() as Promise<T>
}

function jsonRequest<T>(
  path: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

export function getFileRoots(): Promise<{ roots: FileRoot[] }> {
  return request<{ roots: FileRoot[] }>("/api/files/roots")
}

export function listFiles(path: string): Promise<DirectoryListing> {
  const params = new URLSearchParams({ path })
  return request<DirectoryListing>(`/api/files?${params.toString()}`)
}

export function readFile(path: string): Promise<ReadFileResponse> {
  const params = new URLSearchParams({ path })
  return request<ReadFileResponse>(`/api/files/read?${params.toString()}`)
}

export function writeFile(
  path: string,
  content: string,
  expectedModifiedAt?: string,
): Promise<{ status: string; entry: FileEntry }> {
  return jsonRequest("/api/files/write", "PUT", {
    path,
    content,
    expectedModifiedAt,
  })
}

export function createFileItem(payload: {
  parentPath: string
  name: string
  type: "file" | "directory"
  content?: string
}): Promise<{ status: string; entry: FileEntry }> {
  return jsonRequest("/api/files/create", "POST", payload)
}

export function renameFileItem(
  path: string,
  newName: string,
): Promise<{ status: string; entry: FileEntry }> {
  return jsonRequest("/api/files/rename", "PATCH", { path, newName })
}

export function copyFileItems(
  paths: string[],
  destinationPath: string,
): Promise<{ status: string; entries: FileEntry[] }> {
  return jsonRequest("/api/files/copy", "POST", { paths, destinationPath })
}

export function moveFileItems(
  paths: string[],
  destinationPath: string,
): Promise<{ status: string; entries: FileEntry[] }> {
  return jsonRequest("/api/files/move", "POST", { paths, destinationPath })
}

export function runFileItem(path: string): Promise<{ status: string }> {
  return jsonRequest("/api/files/run", "POST", { path })
}

export function deleteFileItem(
  path: string,
  recursive: boolean,
): Promise<{ status: string }> {
  return jsonRequest("/api/files", "DELETE", { path, recursive })
}

export async function uploadFile(
  parentPath: string,
  file: File,
): Promise<{ status: string; entry: FileEntry }> {
  const form = new FormData()
  form.set("parentPath", parentPath)
  form.set("file", file, file.name)
  const res = await launcherFetch("/api/files/upload", {
    method: "POST",
    body: form,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new FilesApiError(body.error || `API error: ${res.status}`, res.status)
  }
  return res.json() as Promise<{ status: string; entry: FileEntry }>
}

export function downloadFileUrl(path: string): string {
  const params = new URLSearchParams({ path })
  return `/api/files/download?${params.toString()}`
}

export function downloadArchiveUrl(paths: string[]): string {
  const params = new URLSearchParams()
  paths.forEach((path) => params.append("paths", path))
  return `/api/files/download-archive?${params.toString()}`
}

export function previewFileUrl(path: string): string {
  const params = new URLSearchParams({ path })
  return `/api/files/preview?${params.toString()}`
}
