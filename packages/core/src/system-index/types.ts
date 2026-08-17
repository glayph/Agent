export interface SystemIndexConfig {
  roots: string[];
  includeSystemRoots: boolean;
  indexContent: boolean;
  realtime: boolean;
  maxFileSizeBytes: number;
  excludedDirectories: string[];
  excludedExtensions: string[];
}

export interface SystemIndexFileInput {
  path: string;
  name: string;
  extension: string;
  parentPath: string;
  sizeBytes: number;
  modifiedAtMs: number;
  createdAtMs: number;
  birthtimeMs: number;
  indexedAt: string;
  contentIndexed: boolean;
  content: string;
  error?: string;
}

export interface SystemIndexSearchResult {
  path: string;
  name: string;
  extension: string;
  parentPath: string;
  sizeBytes: number;
  modifiedAt: string;
  indexedAt: string;
  contentIndexed: boolean;
  snippet: string;
  score: number;
}

export interface SystemIndexStats {
  indexedFiles: number;
  contentIndexedFiles: number;
  totalSizeBytes: number;
  lastIndexedAt: string | null;
}

export interface SystemIndexStatus {
  state: "idle" | "scanning" | "paused" | "stopping";
  config: SystemIndexConfig;
  effectiveRoots: string[];
  stats: SystemIndexStats;
  queueSize: number;
  currentPath: string | null;
  scannedFiles: number;
  startedAt: string | null;
  completedAt: string | null;
  realtimeWatchers: number;
  lastErrors: string[];
}

export const DEFAULT_EXCLUDED_DIRECTORIES = [
  ".git",
  ".aws",
  ".azure",
  ".docker",
  ".gcloud",
  ".gnupg",
  ".hg",
  ".kube",
  ".ssh",
  ".svn",
  ".trash",
  "$recycle.bin",
  "appdata",
  "application data",
  "cache",
  "chrome_agent_profile",
  "dist",
  "logs",
  "node_modules",
  "output",
  "program files",
  "program files (x86)",
  "programdata",
  "recovery",
  "system volume information",
  "temp",
  "tmp",
  "windows",
];

export const DEFAULT_EXCLUDED_EXTENSIONS = [
  ".7z",
  ".bak",
  ".bin",
  ".cab",
  ".crt",
  ".db",
  ".dll",
  ".dmg",
  ".exe",
  ".ico",
  ".iso",
  ".jar",
  ".key",
  ".log",
  ".msi",
  ".pem",
  ".pfx",
  ".p12",
  ".png",
  ".sqlite",
  ".sys",
  ".tar",
  ".tgz",
  ".zip",
];

export const DEFAULT_SYSTEM_INDEX_CONFIG: SystemIndexConfig = {
  roots: [],
  includeSystemRoots: true,
  indexContent: true,
  realtime: true,
  maxFileSizeBytes: 1024 * 1024,
  excludedDirectories: DEFAULT_EXCLUDED_DIRECTORIES,
  excludedExtensions: DEFAULT_EXCLUDED_EXTENSIONS,
};
