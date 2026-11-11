import * as fs from "fs";
import * as path from "path";
import * as tar from "tar";

export interface ExtractOptions {
  stripComponents?: number;
  maxEntries?: number;
  maxExtractedBytes?: number;
}

function archivePathAfterStrip(entryPath: string, strip: number): string {
  const portablePath = entryPath.replaceAll("\\\\", "/");
  if (
    portablePath.startsWith("/") ||
    portablePath.startsWith("\\\\") ||
    /^[A-Za-z]:\//.test(portablePath)
  ) {
    throw new Error(`Archive contains an absolute path: "${entryPath}"`);
  }

  const rawParts = portablePath.split("/").filter(Boolean);
  const strippedParts = rawParts.slice(strip);
  const normalized = path.posix.normalize(strippedParts.join("/"));
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Archive entry escapes destination: "${entryPath}"`);
  }
  return normalized;
}

export async function extractTarGz(
  archivePath: string,
  destDir: string,
  options?: ExtractOptions,
): Promise<string[]> {
  const strip = options?.stripComponents ?? 1;
  const maxEntries = options?.maxEntries ?? 10_000;
  const maxExtractedBytes = options?.maxExtractedBytes ?? 200 * 1024 * 1024;
  if (!Number.isInteger(strip) || strip < 0) {
    throw new Error("stripComponents must be a non-negative integer");
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error("maxEntries must be a positive integer");
  }
  if (!Number.isFinite(maxExtractedBytes) || maxExtractedBytes < 1) {
    throw new Error("maxExtractedBytes must be positive");
  }

  await fs.promises.mkdir(destDir, { recursive: true });

  try {
    let safetyError: Error | undefined;
    let entryCount = 0;
    let extractedBytes = 0;
    await tar.x({
      file: archivePath,
      cwd: destDir,
      strip,
      preservePaths: false,
      strict: true,
      filter: (entryPath, entry) => {
        if (safetyError) return false;
        try {
          archivePathAfterStrip(entryPath, strip);
          entryCount += 1;
          if (entryCount > maxEntries) {
            throw new Error(
              `Archive contains too many entries: ${entryCount} > ${maxEntries}`,
            );
          }
          const entrySize =
            "size" in entry && typeof entry.size === "number" ? entry.size : 0;
          if (entrySize > 0) {
            extractedBytes += entrySize;
            if (extractedBytes > maxExtractedBytes) {
              throw new Error(
                `Archive expands beyond the maximum size of ${maxExtractedBytes} bytes`,
              );
            }
          }
          const entryType =
            "type" in entry
              ? entry.type
              : entry.isSymbolicLink()
                ? "SymbolicLink"
                : entry.isDirectory()
                  ? "Directory"
                  : entry.isFile()
                    ? "File"
                    : "Other";
          if (entryType === "SymbolicLink" || entryType === "Link") {
            throw new Error(`Archive links are not allowed: "${entryPath}"`);
          }
          if (entryType !== "File" && entryType !== "Directory") {
            throw new Error(
              `Archive entry type is not allowed: "${entryPath}" (${entryType})`,
            );
          }
          return true;
        } catch (error: unknown) {
          safetyError =
            error instanceof Error ? error : new Error(String(error));
          return false;
        }
      },
    });
    if (safetyError) throw safetyError;
  } catch (tarErr) {
    const message = tarErr instanceof Error ? tarErr.message : String(tarErr);
    throw new Error(`Failed to extract archive: ${message}`);
  }

  const extracted: string[] = [];
  const collectFiles = async (dir: string) => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectFiles(full);
      } else {
        extracted.push(full);
      }
    }
  };
  await collectFiles(destDir);
  return extracted;
}

// ═══════════════════════════════════════════════════════════════════════
// EXTENSION POINT — Adding support for .zip archives
// ═══════════════════════════════════════════════════════════════════════
// Add a new extractZip function that uses adm-zip or unzipper, then call it
// from source handlers when detecting .zip extensions.
// ═══════════════════════════════════════════════════════════════════════

export async function findManifest(
  dir: string,
): Promise<{ manifest: Record<string, unknown>; filePath: string } | null> {
  const candidates = ["plugin.json", "miki.provider.json", "package.json"];
  for (const candidate of candidates) {
    const fullPath = path.join(dir, candidate);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.isFile()) {
        const content = await fs.promises.readFile(fullPath, "utf-8");
        const parsed = JSON.parse(content) as Record<string, unknown>;
        return { manifest: parsed, filePath: fullPath };
      }
    } catch {
      continue;
    }
  }
  return null;
}
