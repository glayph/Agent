import {
  extractTags,
  parseSkillMarkdown,
  readFrontmatterFields,
} from "./frontmatter.js";

describe("parseSkillMarkdown", () => {
  it("splits frontmatter from the body (CRLF and BOM included)", () => {
    const doc = parseSkillMarkdown(
      "\uFEFF---\r\nname: demo\r\ndescription: A demo\r\n---\r\n# Title\r\nbody",
    );
    expect(doc.data).toEqual({ name: "demo", description: "A demo" });
    expect(doc.body).toBe("# Title\r\nbody");
    expect(doc.error).toBeUndefined();
  });

  it("returns the whole text when there is no frontmatter", () => {
    const doc = parseSkillMarkdown("# Only markdown");
    expect(doc.data).toEqual({});
    expect(doc.body).toBe("# Only markdown");
  });

  it("reports invalid YAML without throwing", () => {
    const doc = parseSkillMarkdown("---\nname: [unclosed\n---\nbody");
    expect(doc.data).toEqual({});
    expect(doc.error).toBeTruthy();
  });

  it("reads tags from the top level and from metadata.<ns>.tags", () => {
    const { data } = parseSkillMarkdown(
      "---\nname: x\ntags: a, b\nmetadata:\n  Miki:\n    tags: [c, d]\n---\n",
    );
    expect(extractTags(data).sort()).toEqual(["a", "b", "c", "d"]);
    expect(readFrontmatterFields(data).name).toBe("x");
  });
});
