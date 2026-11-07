import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG_FILES = ["agent.yaml", "tools.yaml"];

/** Copy shipped runtime defaults into a separate workspace without replacing owner edits. */
export function seedWorkspaceConfig(sourceRoot, configDir) {
  const sourceConfigDir = path.join(path.resolve(sourceRoot), "config");
  const targetConfigDir = path.resolve(configDir);
  fs.mkdirSync(targetConfigDir, { recursive: true });

  const seeded = [];
  for (const name of DEFAULT_CONFIG_FILES) {
    const source = path.join(sourceConfigDir, name);
    const target = path.join(targetConfigDir, name);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    try {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      seeded.push(name);
    } catch (error) {
      // Another launcher may have seeded it concurrently; never overwrite that file.
      if (error?.code !== "EEXIST") throw error;
    }
  }
  return seeded;
}
