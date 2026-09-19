import * as path from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function bundledSkillsRoot(): string {
  const compiledCatalog = path.resolve(__dirname, "catalog");
  if (fs.existsSync(compiledCatalog)) return compiledCatalog;
  return path.resolve(__dirname, "..", "src");
}

export const BUNDLED_SKILLS_ROOT = bundledSkillsRoot();
