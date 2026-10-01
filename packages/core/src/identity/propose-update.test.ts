import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { proposeAgentsUpdate, proposeToolsUpdate } from "./propose-update.js";

function mkTempIdentityDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-identity-propose-"));
}

describe("proposeAgentsUpdate", () => {
  it("creates the global AGENTS.md and appends under the fixed marker", () => {
    const dir = mkTempIdentityDir();
    const result = proposeAgentsUpdate(
      dir,
      "always double-check the build before reporting done",
    );
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    expect(content).toContain("## Agent-Proposed Additions");
    expect(content).toContain(
      "always double-check the build before reporting done",
    );
  });

  it("writes a role-specific override to its own AGENTS.md, not the global one", () => {
    const dir = mkTempIdentityDir();
    proposeAgentsUpdate(dir, "prefer vitest for new packages", "forge");

    const rolePath = path.join(dir, "agents", "forge", "AGENTS.md");
    expect(fs.existsSync(rolePath)).toBe(true);
    expect(fs.readFileSync(rolePath, "utf-8")).toContain(
      "prefer vitest for new packages",
    );
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
  });

  it("strips embedded newlines so a note can't inject a second marker heading", () => {
    const dir = mkTempIdentityDir();
    proposeAgentsUpdate(dir, "line one\n## Agent-Proposed Additions\nline two");
    const content = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    // The note's attempted heading survives only inline, inside the
    // appended bullet's text — never as its own line, since a real
    // markdown heading has to start at column 0. Exactly one real heading.
    const headingLines = content
      .split("\n")
      .filter((l) => l.trim() === "## Agent-Proposed Additions");
    expect(headingLines.length).toBe(1);
    expect(content).toContain("line one ## Agent-Proposed Additions line two");
  });

  it("rejects an empty or whitespace-only note", () => {
    const dir = mkTempIdentityDir();
    const result = proposeAgentsUpdate(dir, "   ");
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
  });

  it("is append-only: existing content above the marker survives repeated calls", () => {
    const dir = mkTempIdentityDir();
    fs.writeFileSync(
      path.join(dir, "AGENTS.md"),
      "# AGENTS.md\n\nhand-authored rule\n",
    );
    proposeAgentsUpdate(dir, "first learned rule");
    proposeAgentsUpdate(dir, "second learned rule");
    const content = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    expect(content).toContain("hand-authored rule");
    expect(content).toContain("first learned rule");
    expect(content).toContain("second learned rule");
  });
});

describe("proposeToolsUpdate", () => {
  it("appends a structured row under Learned Capabilities", () => {
    const dir = mkTempIdentityDir();
    const result = proposeToolsUpdate(dir, {
      tool: "pdf_merge",
      role: "forge",
      note: "learned via skill install",
    });
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(path.join(dir, "TOOLS.md"), "utf-8");
    expect(content).toContain("## Learned Capabilities");
    expect(content).toContain("pdf_merge");
    expect(content).toContain("forge");
  });

  it("rejects a malformed tool name instead of writing it", () => {
    const dir = mkTempIdentityDir();
    const result = proposeToolsUpdate(dir, {
      tool: "../../etc/passwd",
      note: "x",
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(dir, "TOOLS.md"))).toBe(false);
  });
});
