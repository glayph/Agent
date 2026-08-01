import * as fs from "fs";
import * as path from "path";
import * as tar from "tar";

export interface ExtractOptions {
  stripComponents?: number;
}

export async function extractTarGz(
  archivePath: string,
  destDir: string,
  options?: ExtractOptions,
): Promise<string[]> {
  const strip = options?.stripComponents ?? 1;

  await fs.promises.mkdir(destDir, { recursive: true });

  try {
    await tar.x({
      file: archivePath,
      cwd: destDir,
      strip: strip,
    });
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
  const candidates = ["plugin.json", "package.json"];
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
