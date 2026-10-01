import * as fs from "fs";
import { resolveIdentityPaths } from "./paths.js";
import type {
  IdentityLoadResult,
  IdentitySection,
  IdentitySectionName,
} from "./types.js";

// Deterministic, documented load order for the assembled prompt-prefix.
// Do not reorder without updating loader.test.ts's order assertions and
// step 01's acceptance criteria (01-workspace-identity-files.md).
const SECTION_ORDER: IdentitySectionName[] = [
  "SOUL",
  "AGENTS_GLOBAL",
  "AGENTS_ROLE",
  "IDENTITY",
  "USER",
  "TOOLS",
];

const HEADERS: Record<IdentitySectionName, string> = {
  SOUL: "[SOUL]",
  AGENTS_GLOBAL: "[AGENTS]",
  AGENTS_ROLE: "[AGENTS — role override]",
  IDENTITY: "[IDENTITY]",
  USER: "[USER CONTEXT]",
  TOOLS: "[TOOLS]",
};

// Warn at most once per missing/unreadable path per process. USER.md and
// TOOLS.md in particular are fine to leave unwritten; without this a run
// that never fills them in would otherwise log a warning on every turn.
// Mirrors the warn-once pattern already used elsewhere in agent.ts (e.g.
// the turn-profile gap warning).
const warnedPaths = new Set<string>();

function warnOnce(message: string, key: string): void {
  if (warnedPaths.has(key)) return;
  warnedPaths.add(key);
  console.warn(`[identity] ${message}`);
}

function readSection(
  name: IdentitySectionName,
  filePath: string,
): IdentitySection {
  if (!filePath) {
    return { name, path: filePath, present: false, content: "" };
  }
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      return { name, path: filePath, present: true, content };
    }
  } catch (err) {
    warnOnce(
      `Failed to read ${filePath}: ${(err as Error).message}. Treating ${name} as missing.`,
      filePath,
    );
    return { name, path: filePath, present: false, content: "" };
  }
  warnOnce(
    `${name} file not found at ${filePath} — skipping that section.`,
    filePath,
  );
  return { name, path: filePath, present: false, content: "" };
}

/**
 * Load the SOUL/AGENTS/IDENTITY/USER/TOOLS identity files and assemble them
 * into a single prompt-prefix, in the documented, deterministic order:
 * SOUL -> AGENTS (global, then the specialist's own override) -> IDENTITY ->
 * USER -> TOOLS.
 *
 * Intended to be called once per agent turn/run (see agent.ts's
 * _buildSystemContent, which computes it alongside the other prompt blocks
 * it already builds once per turn). Never throws:
 * - a missing individual file just yields an empty, omitted section;
 * - a missing identity directory yields usedIdentityFiles=false so the
 *   caller can fall back to whatever it used before this convention
 *   existed.
 */
/** Header for the memory block appended after the identity files (step 02). */
export const MEMORY_SECTION_HEADER = "[MEMORY]";

export function formatMemorySection(memoryContext: string): string {
  return `${MEMORY_SECTION_HEADER}\n${memoryContext.trim()}`;
}

export function loadIdentityContext(
  identityDir: string,
  specialistId?: string,
  /**
   * Optional memory block (MEMORY.md + recent-notes index, built by
   * memory-files/context.ts). Appended after TOOLS so a session starts with
   * what it previously learned. It is not one of the six identity files, so
   * `sections`/`order` are unchanged.
   */
  memoryContext?: string,
): IdentityLoadResult {
  const paths = resolveIdentityPaths(identityDir);

  if (!fs.existsSync(paths.dir)) {
    return { usedIdentityFiles: false, sections: [], order: [], assembled: "" };
  }

  const bySection: Record<IdentitySectionName, IdentitySection> = {
    SOUL: readSection("SOUL", paths.soul),
    AGENTS_GLOBAL: readSection("AGENTS_GLOBAL", paths.agentsGlobal),
    AGENTS_ROLE: specialistId
      ? readSection("AGENTS_ROLE", paths.agentsRole(specialistId))
      : { name: "AGENTS_ROLE", path: "", present: false, content: "" },
    IDENTITY: readSection("IDENTITY", paths.identity),
    USER: readSection("USER", paths.user),
    TOOLS: readSection("TOOLS", paths.tools),
  };

  const sections = SECTION_ORDER.map((name) => bySection[name]);
  const assembledBody = sections
    .filter((section) => section.present && section.content)
    .map((section) => `${HEADERS[section.name]}\n${section.content}`)
    .join("\n\n");

  const memorySection = memoryContext?.trim()
    ? formatMemorySection(memoryContext)
    : "";
  const assembledAll = [assembledBody, memorySection]
    .filter(Boolean)
    .join("\n\n");

  return {
    usedIdentityFiles: true,
    sections,
    order: SECTION_ORDER,
    assembled: assembledAll ? `${assembledAll}\n` : "",
  };
}
