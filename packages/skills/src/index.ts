import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function bundledSkillsRoot(): string {
  return path.resolve(__dirname, "..", "src");
}

export const BUNDLED_SKILLS_ROOT = bundledSkillsRoot();
