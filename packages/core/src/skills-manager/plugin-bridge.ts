import * as path from "node:path";
import { SkillInstaller, type InstalledSkill } from "@miki/installer";
import type { SkillRecord } from "./skill-store.js";

/**
 * Exposes plugin packages tracked by the installer registry (downloaded-skills)
 * as read-only skill records, and lets the dashboard uninstall them.
 */
export function createPluginBridge(downloadedSkillsDir: string) {
  const installer = new SkillInstaller(downloadedSkillsDir);
  const toRecord = (skill: InstalledSkill): SkillRecord => {
    const installedAt = Date.parse(skill.installedAt);
    return {
      name: skill.name,
      path: path.resolve(skill.assetsPath || skill.path),
      source: "workspace",
      description: skill.description || "",
      origin_kind: "third_party",
      tags: [],
      version: skill.version,
      author: skill.author,
      registry_name: String(skill.sourceProtocol),
      installed_version: skill.version,
      installed_at: Number.isNaN(installedAt) ? undefined : installedAt,
      deletable: true,
      scripts: [],
    };
  };
  return {
    async extraSkills(): Promise<SkillRecord[]> {
      await installer.init();
      return (await installer.listInstalled()).map(toRecord);
    },
    async removeExtra(name: string): Promise<boolean> {
      await installer.init();
      return installer.uninstall(name);
    },
  };
}
