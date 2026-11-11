import * as yaml from "js-yaml";

export interface ParsedSkillDocument {
  /** Parsed YAML frontmatter (empty object when absent or invalid). */
  data: Record<string, unknown>;
  /** Markdown body without the frontmatter block. */
  body: string;
  /** Set when a frontmatter block exists but could not be parsed. */
  error?: string;
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Split a SKILL.md file into YAML frontmatter and markdown body. Never throws. */
export function parseSkillMarkdown(text: string): ParsedSkillDocument {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text.replace(/^\uFEFF/, "") };
  const body = text.slice(match[0].length);
  try {
    const parsed = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return { data: parsed as Record<string, unknown>, body };
    return { data: {}, body, error: "Frontmatter must be a YAML mapping." };
  } catch (error) {
    return {
      data: {},
      body,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

/** Tags may live at `tags` or under `metadata.<anything>.tags`. */
export function extractTags(data: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (value: unknown) => {
    if (Array.isArray(value))
      for (const item of value) {
        const tag = asString(item);
        if (tag) out.add(tag);
      }
    else if (typeof value === "string")
      for (const tag of value.split(",")) if (tag.trim()) out.add(tag.trim());
  };
  add(data.tags);
  const metadata = asRecord(data.metadata);
  if (metadata)
    for (const value of Object.values(metadata)) add(asRecord(value)?.tags);
  return [...out];
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  category?: string;
  tags: string[];
}

export function readFrontmatterFields(
  data: Record<string, unknown>,
): SkillFrontmatter {
  return {
    name: asString(data.name),
    description: asString(data.description),
    version: asString(data.version),
    author: asString(data.author),
    license: asString(data.license),
    category: asString(data.category),
    tags: extractTags(data),
  };
}
