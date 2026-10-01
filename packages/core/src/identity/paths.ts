import * as path from "path";

/**
 * Base file/section names for the identity convention. Kept in one place so
 * the loader, the SOUL guard, and the propose-update helpers can never drift
 * apart about where a file lives.
 */
export const SOUL_FILE = "SOUL.md";
export const AGENTS_FILE = "AGENTS.md";
export const IDENTITY_FILE = "IDENTITY.md";
export const USER_FILE = "USER.md";
export const TOOLS_FILE = "TOOLS.md";

export interface IdentityFilePaths {
  dir: string;
  soul: string;
  agentsGlobal: string;
  identity: string;
  user: string;
  tools: string;
  /** Per-specialist AGENTS.md override, e.g. identity/agents/forge/AGENTS.md.
   * Specialist ids come from packages/core/src/plugins/agent-to-agent's
   * DEFAULT_SPECIALISTS (miki/sage/forge/scout) but this is not restricted
   * to that list — any specialistId string resolves consistently. */
  agentsRole: (specialistId: string) => string;
}

export function resolveIdentityPaths(identityDir: string): IdentityFilePaths {
  const dir = path.resolve(identityDir);
  return {
    dir,
    soul: path.join(dir, SOUL_FILE),
    agentsGlobal: path.join(dir, AGENTS_FILE),
    identity: path.join(dir, IDENTITY_FILE),
    user: path.join(dir, USER_FILE),
    tools: path.join(dir, TOOLS_FILE),
    agentsRole: (specialistId: string) =>
      path.join(dir, "agents", specialistId, AGENTS_FILE),
  };
}
