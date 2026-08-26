import * as fs from "fs";
import * as path from "path";
import { type RuntimePaths } from "../paths.js";
import { getMemory } from "../memory/memory-bridge.js";
import { findFolderForPath } from "./store.js";
import type { FolderRulesPayload, WorkspaceFolder } from "./types.js";

const MAX_RULE_FILE_BYTES = 256 * 1024;

/**
 * Returns true if long-term memory already stores rules/notes for this folder.
 * When true, on-disk rule files are skipped (user memory wins).
 */
export function memoryHasFolderRules(folderPath: string): boolean {
  const memory = getMemory();
  if (!memory) return false;
  try {
    const query = `folder rules ${folderPath}`;
    // Prefer keyword search if available (optional methods not on the typed interface)
    const mem = memory as unknown as {
      searchKeyword?: (q: string) => Array<{ content?: string; text?: string }>;
      searchFacts?: (q: string) => Array<{ content?: string }>;
    };
    if (typeof mem.searchKeyword === "function") {
      const hits = mem.searchKeyword(query);
      if (Array.isArray(hits) && hits.length > 0) {
        const needle = path.resolve(folderPath).toLowerCase();
        return hits.some((h) => {
          const text = `${h.content || ""} ${h.text || ""}`.toLowerCase();
          return (
            text.includes(needle) &&
            (text.includes("rule") ||
              text.includes("নিয়ম") ||
              text.includes("gitignore") ||
              text.includes("workspace folder"))
          );
        });
      }
    }
    // Fallback: getContext / facts style APIs
    if (typeof mem.searchFacts === "function") {
      const facts = mem.searchFacts(folderPath);
      if (Array.isArray(facts) && facts.length > 0) {
        return facts.some((f) =>
          /rule|নিয়ম|gitignore|workspace/i.test(String(f.content || "")),
        );
      }
    }
  } catch {
    // memory must never break rule loading
  }
  return false;
}

function readRuleFile(folderRoot: string, relative: string): string | null {
  const full = path.resolve(folderRoot, relative);
  const root = path.resolve(folderRoot);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    if (!fs.existsSync(full)) return null;
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > MAX_RULE_FILE_BYTES) return null;
    return fs.readFileSync(full, "utf-8");
  } catch {
    return null;
  }
}

export function loadFolderRules(
  runtimePaths: RuntimePaths,
  targetPath: string,
): FolderRulesPayload | null {
  const folder = findFolderForPath(runtimePaths, targetPath);
  if (!folder || !folder.enabled) return null;

  if (memoryHasFolderRules(folder.path)) {
    return {
      folderId: folder.id,
      folderPath: folder.path,
      skippedDueToMemory: true,
      rules: [],
    };
  }

  const rules: Array<{ file: string; content: string }> = [];
  for (const rel of folder.rulesFiles) {
    const content = readRuleFile(folder.path, rel);
    if (content != null && content.trim()) {
      rules.push({ file: rel, content: content.slice(0, MAX_RULE_FILE_BYTES) });
    }
  }

  return {
    folderId: folder.id,
    folderPath: folder.path,
    skippedDueToMemory: false,
    rules,
  };
}

export function formatFolderRulesForPrompt(
  payload: FolderRulesPayload | null,
): string {
  if (!payload) return "";
  if (payload.skippedDueToMemory) {
    return (
      `\n[WORKSPACE FOLDER RULES]\n` +
      `Folder: ${payload.folderPath}\n` +
      `On-disk rule files skipped — long-term memory already has rules for this folder.\n`
    );
  }
  if (payload.rules.length === 0) return "";
  const blocks = payload.rules.map(
    (r) => `--- ${r.file} ---\n${r.content.trim()}\n`,
  );
  return (
    `\n[WORKSPACE FOLDER RULES]\n` +
    `Folder: ${payload.folderPath}\n` +
    `Follow these project rules while working inside this folder:\n` +
    blocks.join("\n")
  );
}

export function describeFolderPolicy(folder: WorkspaceFolder): string {
  const bits = [
    `path=${folder.path}`,
    `index=${folder.index}`,
    `restrictDefault=${folder.restrictDefault}`,
    `rules=${folder.rulesFiles.join(",")}`,
  ];
  return bits.join("; ");
}
