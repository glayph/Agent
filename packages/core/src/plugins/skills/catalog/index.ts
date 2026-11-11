import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Root directory of Miki's bundled skill catalog in source and runtime builds. */
export function bundledSkillsRoot(): string {
  return __dirname;
}

export const BUNDLED_SKILLS_ROOT = bundledSkillsRoot();
