import * as fs from "fs";
import * as path from "path";
import { normalizeRuntimePaths, type RuntimePaths } from "./paths.js";

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  author?: string;
  version?: string;
  dependencies?: string[];
  enabled: boolean;
  path: string;
}

export interface SearchQuery {
  keywords?: string[];
  category?: string;
  tags?: string[];
  enabled?: boolean;
  limit?: number;
}

export interface SearchResult {
  results: SkillMetadata[];
  total: number;
  query: SearchQuery;
  executionTimeMs: number;
}

export class SkillSearchEngine {
  private skillsDirs: string[];
  private skillCache: Map<string, SkillMetadata> = new Map();
  private lastCacheTime: number = 0;
  private cacheDurationMs: number = 24 * 60 * 60 * 1000;

  constructor(paths: RuntimePaths | string, additionalDirs: string[] = []) {
    const runtimePaths = normalizeRuntimePaths(paths);
    const bundledSkillsDir = runtimePaths.sourceDir
      ? path.resolve(
          runtimePaths.sourceDir,
          "packages",
          "skills",
          "src",
        )
      : path.resolve(runtimePaths.skillsDir, "..", "skills");
    const userSkillsDir = path.resolve(runtimePaths.skillsDir);
    this.skillsDirs = Array.from(
      new Set([
        bundledSkillsDir,
        userSkillsDir,
        ...additionalDirs.map((dir) => path.resolve(dir)),
      ]),
    );
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const startTime = Date.now();
    await this.loadSkills();

    let results = Array.from(this.skillCache.values());

    if (query.keywords?.length) {
      const rawKeywords = query.keywords
        .flatMap((kw) => kw.toLowerCase().split(/\s+/))
        .filter((kw) => kw.length > 2);

      const scored: Array<{ skill: SkillMetadata; score: number }> = [];
      for (const skill of results) {
        const searchText = `${skill.name} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase();
        let score = 0;
        for (const kw of rawKeywords) {
          if (searchText.includes(kw)) score += 1;
          if (skill.tags.some((t) => t.toLowerCase().includes(kw))) score += 2;
          if (skill.name.toLowerCase().includes(kw)) score += 3;
        }
        if (score > 0) scored.push({ skill, score });
      }
      scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
      results = scored.map((s) => s.skill);
    }

    if (query.category) {
      const cat = query.category.toLowerCase();
      results = results.filter((s) => s.category.toLowerCase() === cat);
    }
    if (query.tags?.length) {
      const qTags = query.tags.map((t) => t.toLowerCase());
      results = results.filter((s) =>
        qTags.some((qt) => s.tags.some((st) => st.toLowerCase() === qt)),
      );
    }
    if (query.enabled !== undefined) {
      results = results.filter((s) => s.enabled === query.enabled);
    }
    if (query.limit && query.limit > 0) {
      results = results.slice(0, Math.min(query.limit, 100));
    }

    return {
      results,
      total: results.length,
      query,
      executionTimeMs: Date.now() - startTime,
    };
  }

  async getSkill(skillId: string): Promise<SkillMetadata | null> {
    await this.loadSkills();
    return this.skillCache.get(skillId) || null;
  }

  async getCategory(category: string): Promise<SkillMetadata[]> {
    await this.loadSkills();
    const cat = category.toLowerCase();
    return Array.from(this.skillCache.values()).filter(
      (s) => s.category.toLowerCase() === cat,
    );
  }

  async getCategories(): Promise<string[]> {
    await this.loadSkills();
    const cats = new Set(
      Array.from(this.skillCache.values()).map((s) => s.category),
    );
    return Array.from(cats).sort();
  }

  async getTags(): Promise<string[]> {
    await this.loadSkills();
    const tags = new Set<string>();
    for (const skill of this.skillCache.values()) {
      for (const tag of skill.tags) tags.add(tag);
    }
    return Array.from(tags).sort();
  }

  async listAll(enabledOnly = false): Promise<SkillMetadata[]> {
    await this.loadSkills();
    let skills = Array.from(this.skillCache.values());
    if (enabledOnly) skills = skills.filter((s) => s.enabled);
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async loadSkills(): Promise<void> {
    const now = Date.now();
    if (this.skillCache.size > 0 && now - this.lastCacheTime < this.cacheDurationMs) {
      return;
    }
    this.skillCache.clear();
    for (const skillsDir of this.skillsDirs) {
      this.scanSkillsDir(skillsDir);
    }
    this.lastCacheTime = now;
  }

  private scanSkillsDir(skillsDir: string): void {
    const categoriesPath = path.join(skillsDir, "categories.json");
    const dethSkillsPath = path.join(skillsDir, "deth_skills.json");
    let categories: string[] = [];
    let uninstalledSkills: string[] = [];

    if (fs.existsSync(dethSkillsPath)) {
      try {
        const dethData = JSON.parse(fs.readFileSync(dethSkillsPath, "utf-8"));
        uninstalledSkills = dethData.uninstalled_skills || [];
      } catch (err) {
        console.error("Failed to load deth_skills.json:", err);
      }
    }
    if (fs.existsSync(categoriesPath)) {
      try {
        const categoriesData = JSON.parse(fs.readFileSync(categoriesPath, "utf-8"));
        categories = categoriesData.categories || [];
      } catch (err) {
        console.error("Failed to load categories.json:", err);
      }
    }

    for (const categoryName of categories) {
      const categoryPath = path.join(skillsDir, categoryName);
      if (!fs.existsSync(categoryPath)) continue;
      const skillsPath = path.join(categoryPath, "skills.json");
      if (!fs.existsSync(skillsPath)) continue;

      let skillIds: string[] = [];
      try {
        const skillsData = JSON.parse(fs.readFileSync(skillsPath, "utf-8"));
        skillIds = skillsData.skills || [];
      } catch (err) {
        console.error(`Failed to load skills.json for category ${categoryName}:`, err);
      }

      for (const skillName of skillIds) {
        const skillId = `${categoryName}/${skillName}`;
        if (uninstalledSkills.includes(skillId)) continue;
        const skillPath = path.join(categoryPath, skillName);
        if (!fs.existsSync(skillPath)) continue;

        const skillMetadataPath = this.findMetadataFile(skillPath);
        const skillMdPath = path.join(skillPath, "SKILL.md");
        let parsedMeta: Partial<SkillMetadata> | null = null;

        if (fs.existsSync(skillMdPath)) {
          parsedMeta = this.parseSkillMdFrontmatter(skillMdPath);
        }
        if (skillMetadataPath) {
          try {
            const metadata = JSON.parse(
              fs.readFileSync(skillMetadataPath, "utf-8"),
            ) as Partial<SkillMetadata>;
            parsedMeta = { ...parsedMeta, ...metadata };
          } catch (err) {
            console.error(`Failed to load skill metadata from ${skillMetadataPath}:`, err);
          }
        }

        if (parsedMeta) {
          this.skillCache.set(skillId, {
            id: parsedMeta.id || skillId,
            name: parsedMeta.name || skillName,
            description: parsedMeta.description || "",
            category: parsedMeta.category || categoryName,
            tags: parsedMeta.tags || [],
            author: parsedMeta.author,
            version: parsedMeta.version || "1.0.0",
            dependencies: parsedMeta.dependencies || [],
            enabled: parsedMeta.enabled !== false,
            path: skillPath,
          });
        } else {
          this.skillCache.set(skillId, {
            id: skillId,
            name: skillName,
            description: "",
            category: categoryName,
            tags: [],
            version: "1.0.0",
            enabled: true,
            path: skillPath,
          });
        }
      }
    }
  }

  private parseSkillMdFrontmatter(skillMdPath: string): Partial<SkillMetadata> | null {
    try {
      const content = fs.readFileSync(skillMdPath, "utf-8");
      const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!match) return null;
      const frontmatter = match[1];
      const meta: Partial<SkillMetadata> = { tags: [] };
      for (const line of frontmatter.split("\n")) {
        const kvMatch = line.match(/^\s*(\w+)\s*:\s*(.*?)\s*$/);
        if (!kvMatch) continue;
        const key = kvMatch[1];
        const value = kvMatch[2].trim();
        switch (key) {
          case "name": meta.name = value.replace(/^["']|["']$/g, ""); break;
          case "description": meta.description = value.replace(/^["']|["']$/g, ""); break;
          case "version": meta.version = value.replace(/^["']|["']$/g, ""); break;
          case "author": meta.author = value.replace(/^["']|["']$/g, ""); break;
          case "tags": {
            const tagMatch = value.match(/\[([^\]]*)\]/);
            if (tagMatch) {
              meta.tags = tagMatch[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
            }
            break;
          }
          case "category":
            meta.category = value.replace(/^["']|["']$/g, "");
            meta.id = `${meta.category}/${meta.name || "unknown"}`;
            break;
        }
      }
      return Object.keys(meta).length > 0 ? meta : null;
    } catch {
      return null;
    }
  }

  private findMetadataFile(skillPath: string): string | null {
    for (const name of [".marketplace.json", "skill.json", "skill.metadata.json", "metadata.json", "package.json"]) {
      const fp = path.join(skillPath, name);
      if (fs.existsSync(fp)) return fp;
    }
    return null;
  }

  clearCache(): void {
    this.skillCache.clear();
    this.lastCacheTime = 0;
  }

  getCacheStats() {
    const categories = new Set(Array.from(this.skillCache.values()).map((s) => s.category));
    return {
      skillsLoaded: this.skillCache.size,
      categories: Array.from(categories),
      cacheAgeMs: Date.now() - this.lastCacheTime,
    };
  }
}
