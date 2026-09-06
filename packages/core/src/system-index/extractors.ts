import * as fs from "fs";
import * as path from "path";
import type { SystemIndexConfig } from "./types.js";

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".php",
  ".ps1",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".cer",
  ".crt",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
]);

export function normalizeExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function isSensitiveFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return (
    SENSITIVE_FILE_NAMES.has(name) ||
    SENSITIVE_EXTENSIONS.has(normalizeExtension(filePath))
  );
}

export function shouldSkipDirectory(
  directoryPath: string,
  config: SystemIndexConfig,
): boolean {
  const name = path.basename(directoryPath).toLowerCase();
  return config.excludedDirectories
    .map((item) => item.toLowerCase())
    .includes(name);
}

export function shouldSkipFile(
  filePath: string,
  config: SystemIndexConfig,
): boolean {
  if (isSensitiveFile(filePath)) return true;
  const extension = normalizeExtension(filePath);
  return config.excludedExtensions
    .map((item) => item.toLowerCase())
    .includes(extension);
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export async function extractIndexableContent(
  filePath: string,
  stat: fs.Stats,
  config: SystemIndexConfig,
): Promise<{ content: string; contentIndexed: boolean; error?: string }> {
  if (!config.indexContent || stat.size > config.maxFileSizeBytes) {
    return { content: "", contentIndexed: false };
  }
  if (!TEXT_EXTENSIONS.has(normalizeExtension(filePath))) {
    return { content: "", contentIndexed: false };
  }

  try {
    const buffer = await fs.promises.readFile(filePath);
    if (looksBinary(buffer)) {
      return { content: "", contentIndexed: false };
    }
    return {
      content: buffer.toString("utf-8").slice(0, config.maxFileSizeBytes),
      contentIndexed: true,
    };
  } catch (err) {
    return {
      content: "",
      contentIndexed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
