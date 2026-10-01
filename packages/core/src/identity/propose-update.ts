import * as fs from "fs";
import * as path from "path";
import { AGENTS_FILE, TOOLS_FILE, resolveIdentityPaths } from "./paths.js";
import { isSoulProtectedPath } from "./guard.js";

const AGENTS_APPEND_MARKER = "## Agent-Proposed Additions";
const TOOLS_APPEND_MARKER = "## Learned Capabilities";

export interface ProposeResult {
  ok: boolean;
  message: string;
  path?: string;
}

function sanitizeLine(text: string): string {
  // A proposed update is always one line appended under a fixed marker —
  // never a free-form file rewrite. Stripping newlines stops a caller from
  // smuggling in extra markdown structure (a heading, a second marker, an
  // edit to an earlier line) through the note text.
  return text.replace(/\r?\n+/g, " ").trim();
}

function appendUnderMarker(
  filePath: string,
  marker: string,
  seedHeader: string,
  line: string,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let content = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : seedHeader;
  if (!content.includes(marker)) {
    content = `${content.trimEnd()}\n\n${marker}\n`;
  }
  fs.writeFileSync(filePath, `${content.trimEnd()}\n${line}\n`, "utf-8");
}

/**
 * The only sanctioned way for the agent to add an operating rule it has
 * learned to AGENTS.md — either the global file, or one specialist's own
 * override when `specialistId` is given. Always appends exactly one
 * timestamped bullet under the fixed "## Agent-Proposed Additions" marker;
 * never rewrites the rest of the file. Creates the target file (seeded with
 * a heading) if it doesn't exist yet. Refuses outright if the resolved
 * target is SOUL.md — defense in depth, even though no caller should ever
 * be able to construct that path through this function today.
 */
export function proposeAgentsUpdate(
  identityDir: string,
  note: string,
  specialistId?: string,
): ProposeResult {
  const paths = resolveIdentityPaths(identityDir);
  const target = specialistId
    ? paths.agentsRole(specialistId)
    : paths.agentsGlobal;

  if (isSoulProtectedPath(target, identityDir)) {
    return {
      ok: false,
      message: "Refused: target resolves to a protected identity file.",
    };
  }

  const line = sanitizeLine(note);
  if (!line) {
    return { ok: false, message: "Refused: empty note." };
  }

  try {
    appendUnderMarker(
      target,
      AGENTS_APPEND_MARKER,
      `# ${AGENTS_FILE}${specialistId ? ` (${specialistId} override)` : ""}\n`,
      `- ${new Date().toISOString()}: ${line}`,
    );
    return { ok: true, message: "Appended.", path: target };
  } catch (err) {
    return { ok: false, message: `Failed: ${(err as Error).message}` };
  }
}

export interface ToolUpdateEntry {
  tool: string;
  role?: string;
  note: string;
}

const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/;

/**
 * The only sanctioned way for the agent to record a newly learned
 * tool/macro capability in TOOLS.md. Same append-only discipline as
 * proposeAgentsUpdate(): exactly one structured row under
 * "## Learned Capabilities", never a rewrite of the file's existing
 * content (e.g. the specialist capability table seeded in step 01).
 *
 * Not yet wired up as a callable LLM tool — that belongs to step 04
 * (tool-exec-permissions) / step 05 (skills-plugin-system), once there is a
 * permission-gated tool layer to register it against. This function is the
 * guarded primitive those steps can call.
 */
export function proposeToolsUpdate(
  identityDir: string,
  entry: ToolUpdateEntry,
): ProposeResult {
  const paths = resolveIdentityPaths(identityDir);

  if (!TOOL_NAME_PATTERN.test(entry.tool)) {
    return {
      ok: false,
      message: `Refused: '${entry.tool}' is not a valid tool name.`,
    };
  }

  const note = sanitizeLine(entry.note);
  const role = entry.role ? sanitizeLine(entry.role) : "any";

  try {
    appendUnderMarker(
      paths.tools,
      TOOLS_APPEND_MARKER,
      `# ${TOOLS_FILE}\n`,
      `- ${new Date().toISOString()} | ${entry.tool} | ${role} | ${note}`,
    );
    return { ok: true, message: "Appended.", path: paths.tools };
  } catch (err) {
    return { ok: false, message: `Failed: ${(err as Error).message}` };
  }
}
