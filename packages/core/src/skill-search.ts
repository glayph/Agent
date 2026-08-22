import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import {
  normalizeRuntimePaths,
  resolveDownloadedSkillsDir,
  type RuntimePaths,
} from "./paths.js";
import type { RuntimeRequirement } from "./runtime-fetch/types.js";
import { SkillRegistry, type InstalledSkill } from "@miki/installer";

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  author?: string;
  version?: string;
  /** Legacy flat dependency list. Historically assumed Python/pip; kept for
   * backward compatibility. New skills should use `runtime` instead. */
  dependencies?: string[];
  /** External language runtimes this skill needs (Python, Ruby, Rust, ...). */
  runtime?: RuntimeRequirement[];
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
  private downloadedSkillsDir: string;
  private skillCache: Map<string, SkillMetadata> = new Map();
  private lastCacheTime: number = 0;
  private cacheDurationMs: number = 24 * 60 * 60 * 1000;

  constructor(paths: RuntimePaths | string, additionalDirs: string[] = []) {
    const runtimePaths = normalizeRuntimePaths(paths);
    const bundledSkillsDir = runtimePaths.sourceDir
      ? path.resolve(runtimePaths.sourceDir, "packages", "skills", "src")
      : path.resolve(runtimePaths.skillsDir, "..", "skills");
    const userSkillsDir = path.resolve(runtimePaths.skillsDir);
    this.skillsDirs = Array.from(
      new Set([
        bundledSkillsDir,
        userSkillsDir,
        ...additionalDirs.map((dir) => path.resolve(dir)),
      ]),
    );
    // Marketplace/plugin installs go through SkillInstaller, which (per
    // resolveDownloadedSkillsDir's sandbox_mode contract) writes to
    // <dataDir>/downloaded-skills, not userSkillsDir, and tracks them as
    // flat <name>.ts + <name>_assets/ files in its own SkillRegistry state
    // file rather than the categories.json/skills.json layout scanSkillsDir
    // expects. Without this, installed-skill metadata is invisible to
    // search/listing from the moment of install, and appears "lost" every
    // time the cache is rebuilt (server restart, refreshCache(), TTL expiry).
    this.downloadedSkillsDir = resolveDownloadedSkillsDir(runtimePaths);
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
        const searchText =
          `${skill.name} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase();
        let score = 0;
        for (const kw of rawKeywords) {
          if (searchText.includes(kw)) score += 1;
          if (skill.tags.some((t) => t.toLowerCase().includes(kw))) score += 2;
          if (skill.name.toLowerCase().includes(kw)) score += 3;
        }
        if (score > 0) scored.push({ skill, score });
      }
      scored.sort(
        (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
      );
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
    if (
      this.skillCache.size > 0 &&
      now - this.lastCacheTime < this.cacheDurationMs
    ) {
      return;
    }
    this.skillCache.clear();
    for (const skillsDir of this.skillsDirs) {
      this.scanSkillsDir(skillsDir);
    }
    await this.scanInstalledRegistry();
    this.lastCacheTime = now;
  }

  /**
   * Merges skills installed via SkillInstaller (tracked in its own
   * SkillRegistry state file at downloadedSkillsDir) into skillCache.
   * These never live under a categories.json/skills.json category folder,
   * so scanSkillsDir() can never see them on its own. A curated/bundled
   * skill with the same id always wins on collision.
   */
  private async scanInstalledRegistry(): Promise<void> {
    try {
      const registry = new SkillRegistry(this.downloadedSkillsDir);
      await registry.init();
      const installed: InstalledSkill[] = await registry.listInstalled();
      for (const skill of installed) {
        if (!skill.name || this.skillCache.has(skill.name)) continue;
        this.skillCache.set(skill.name, {
          id: skill.name,
          name: skill.name,
          description: skill.description || "",
          category: "marketplace",
          tags: [],
          author: skill.author,
          version: skill.version || "0.0.0",
          enabled: true,
          path: skill.assetsPath || skill.path,
        });
      }
    } catch (err) {
      console.error(
        `Failed to load installed-skill registry from ${this.downloadedSkillsDir}:`,
        err,
      );
    }
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
        const categoriesData = JSON.parse(
          fs.readFileSync(categoriesPath, "utf-8"),
        );
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
        console.error(
          `Failed to load skills.json for category ${categoryName}:`,
          err,
        );
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
            console.error(
              `Failed to load skill metadata from ${skillMetadataPath}:`,
              err,
            );
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
            runtime: parsedMeta.runtime,
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

  private parseSkillMdFrontmatter(
    skillMdPath: string,
  ): Partial<SkillMetadata> | null {
    try {
      const content = fs.readFileSync(skillMdPath, "utf-8");
      const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!match) return null;
      const frontmatter = match[1];

      // Prefer a real YAML parse: it handles every field the legacy
      // line-by-line parser understood (name, description, version, author,
      // single-line tags/dependencies arrays) *and* new nested structures
      // like `runtime: [...]` the legacy parser can't express. Fall back to
      // the legacy parser only if the frontmatter isn't valid YAML.
      const viaYaml = this.parseFrontmatterYaml(frontmatter);
      if (viaYaml) return viaYaml;

      const meta: Partial<SkillMetadata> = { tags: [] };
      for (const line of frontmatter.split("\n")) {
        const kvMatch = line.match(/^\s*(\w+)\s*:\s*(.*?)\s*$/);
        if (!kvMatch) continue;
        const key = kvMatch[1];
        const value = kvMatch[2].trim();
        switch (key) {
          case "name":
            meta.name = value.replace(/^["']|["']$/g, "");
            break;
          case "description":
            meta.description = value.replace(/^["']|["']$/g, "");
            break;
          case "version":
            meta.version = value.replace(/^["']|["']$/g, "");
            break;
          case "author":
            meta.author = value.replace(/^["']|["']$/g, "");
            break;
          case "tags": {
            const tagMatch = value.match(/\[([^\]]*)\]/);
            if (tagMatch) {
              meta.tags = tagMatch[1]
                .split(",")
                .map((t) => t.trim().replace(/^["']|["']$/g, ""))
                .filter(Boolean);
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

  /**
   * Parse frontmatter as real YAML. Returns null (never throws) on malformed
   * YAML or missing `name`, so callers fall back to the legacy line parser.
   */
  private parseFrontmatterYaml(
    frontmatter: string,
  ): Partial<SkillMetadata> | null {
    let doc: unknown;
    try {
      doc = yaml.load(frontmatter);
    } catch {
      return null;
    }
    if (!doc || typeof doc !== "object") return null;
    const raw = doc as Record<string, unknown>;

    const meta: Partial<SkillMetadata> = { tags: [] };
    if (typeof raw.name === "string") meta.name = raw.name;
    if (typeof raw.description === "string") meta.description = raw.description;
    if (typeof raw.version === "string") meta.version = String(raw.version);
    if (typeof raw.author === "string") meta.author = raw.author;
    if (typeof raw.category === "string") {
      meta.category = raw.category;
      meta.id = `${meta.category}/${meta.name || "unknown"}`;
    }
    if (Array.isArray(raw.tags)) {
      meta.tags = raw.tags.filter((t): t is string => typeof t === "string");
    }
    if (Array.isArray(raw.dependencies)) {
      meta.dependencies = raw.dependencies.filter(
        (d): d is string => typeof d === "string",
      );
    }
    if (Array.isArray(raw.runtime)) {
      meta.runtime = this.normalizeRuntimeList(raw.runtime, meta.dependencies);
    } else if (meta.dependencies && meta.dependencies.length > 0) {
      // Legacy skills declared a flat `dependencies` list with no language
      // tag. Every such skill in this codebase historically meant Python/pip
      // (e.g. research-paper-writing), so treat that as the compatibility
      // default rather than silently dropping the requirement.
      meta.runtime = [{ language: "python", packages: meta.dependencies }];
    }

    // Require at least `name`; otherwise treat as "not real frontmatter" and
    // let the caller fall back to the legacy parser.
    if (!meta.name) return null;
    return meta;
  }

  private normalizeRuntimeList(
    raw: unknown[],
    legacyDependencies?: string[],
  ): RuntimeRequirement[] {
    const out: RuntimeRequirement[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const r = entry as Record<string, unknown>;
      if (typeof r.language !== "string" || !r.language.trim()) continue;
      const packages = Array.isArray(r.packages)
        ? r.packages.filter((p): p is string => typeof p === "string")
        : legacyDependencies || [];
      out.push({
        language: r.language.trim().toLowerCase(),
        version: typeof r.version === "string" ? r.version : undefined,
        packages,
      });
    }
    return out;
  }

  private findMetadataFile(skillPath: string): string | null {
    for (const name of [
      ".marketplace.json",
      "skill.json",
      "skill.metadata.json",
      "metadata.json",
      "package.json",
    ]) {
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
    const categories = new Set(
      Array.from(this.skillCache.values()).map((s) => s.category),
    );
    return {
      skillsLoaded: this.skillCache.size,
      categories: Array.from(categories),
      cacheAgeMs: Date.now() - this.lastCacheTime,
    };
  }
}
