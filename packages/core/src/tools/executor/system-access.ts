// Miki is a systemwide agent: by default its file/shell tools are NOT confined
// to any workspace directory. `workspaceDir` (the install root) remains the
// default base for relative paths and the default shell cwd, but it is not a
// permission boundary unless an operator explicitly opts in with
// `agent.security.system_access: workspace_only | isolated` in agent.yaml.
//
// Any failure to read/parse the config resolves to "full" (systemwide) — the
// intended default — rather than silently confining the agent.
import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";

export type SystemAccessMode = "full" | "workspace_only" | "isolated";

const VALID_MODES: ReadonlySet<string> = new Set([
  "full",
  "workspace_only",
  "isolated",
]);

let cachedPath: string | undefined;
let cachedMtimeMs = 0;
let cachedMode: SystemAccessMode = "full";

export function parseSystemAccessMode(value: unknown): SystemAccessMode {
  return typeof value === "string" && VALID_MODES.has(value)
    ? (value as SystemAccessMode)
    : "full";
}

/** Whether a mode confines file/shell tools to the workspace directory. */
export function modeEnforcesBoundary(mode: SystemAccessMode): boolean {
  return mode !== "full";
}

export function loadSystemAccessMode(configDir: string): SystemAccessMode {
  const agentYamlPath = path.join(configDir, "agent.yaml");
  try {
    const stat = fs.statSync(agentYamlPath);
    if (cachedPath === agentYamlPath && cachedMtimeMs === stat.mtimeMs) {
      return cachedMode;
    }
    const doc = yaml.load(fs.readFileSync(agentYamlPath, "utf-8")) as
      | { agent?: { security?: { system_access?: unknown } } }
      | undefined;
    cachedMode = parseSystemAccessMode(doc?.agent?.security?.system_access);
    cachedPath = agentYamlPath;
    cachedMtimeMs = stat.mtimeMs;
    return cachedMode;
  } catch {
    return "full";
  }
}
