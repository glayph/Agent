import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadIdentityContext } from "./loader.js";

function mkTempIdentityDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-identity-"));
}

describe("loadIdentityContext", () => {
  it("reports usedIdentityFiles=false when the identity directory does not exist", () => {
    const dir = path.join(
      os.tmpdir(),
      `miki-identity-missing-${Date.now()}-${Math.random()}`,
    );
    const result = loadIdentityContext(dir);
    expect(result.usedIdentityFiles).toBe(false);
    expect(result.assembled).toBe("");
    expect(result.sections).toEqual([]);
    expect(result.order).toEqual([]);
  });

  it("loads all five files in the documented order: SOUL -> AGENTS -> IDENTITY -> USER -> TOOLS", () => {
    const dir = mkTempIdentityDir();
    fs.writeFileSync(path.join(dir, "SOUL.md"), "core values");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "global rules");
    fs.writeFileSync(path.join(dir, "IDENTITY.md"), "who am i");
    fs.writeFileSync(path.join(dir, "USER.md"), "about the operator");
    fs.writeFileSync(path.join(dir, "TOOLS.md"), "capability registry");

    const result = loadIdentityContext(dir);
    expect(result.usedIdentityFiles).toBe(true);
    expect(result.order).toEqual([
      "SOUL",
      "AGENTS_GLOBAL",
      "AGENTS_ROLE",
      "IDENTITY",
      "USER",
      "TOOLS",
    ]);

    // The order must hold in the assembled text itself, not just in
    // `order` — that's what actually lands in the prompt.
    const idx = (needle: string) => result.assembled.indexOf(needle);
    expect(idx("core values")).toBeGreaterThanOrEqual(0);
    expect(idx("core values")).toBeLessThan(idx("global rules"));
    expect(idx("global rules")).toBeLessThan(idx("who am i"));
    expect(idx("who am i")).toBeLessThan(idx("about the operator"));
    expect(idx("about the operator")).toBeLessThan(idx("capability registry"));
  });

  it("is deterministic across repeated calls against the same files", () => {
    const dir = mkTempIdentityDir();
    fs.writeFileSync(path.join(dir, "SOUL.md"), "core values");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "global rules");

    const first = loadIdentityContext(dir);
    const second = loadIdentityContext(dir);
    expect(second.assembled).toBe(first.assembled);
    expect(second.order).toEqual(first.order);
  });

  it("never crashes when a file is missing — it just skips that section", () => {
    const dir = mkTempIdentityDir();
    fs.writeFileSync(path.join(dir, "SOUL.md"), "core values");
    // AGENTS.md / IDENTITY.md / USER.md / TOOLS.md intentionally absent.

    const result = loadIdentityContext(dir);
    expect(result.usedIdentityFiles).toBe(true);
    expect(result.assembled).toContain("core values");

    const byName = Object.fromEntries(result.sections.map((s) => [s.name, s]));
    expect(byName.AGENTS_GLOBAL.present).toBe(false);
    expect(byName.IDENTITY.present).toBe(false);
    expect(byName.USER.present).toBe(false);
    expect(byName.TOOLS.present).toBe(false);
    // Missing sections are omitted from the assembled text, not left as
    // empty headers.
    expect(result.assembled).not.toContain("[AGENTS]");
  });

  it("only includes a role-specific AGENTS.md override for the matching specialistId", () => {
    const dir = mkTempIdentityDir();
    fs.writeFileSync(path.join(dir, "SOUL.md"), "core values");
    fs.mkdirSync(path.join(dir, "agents", "forge"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "agents", "forge", "AGENTS.md"),
      "forge-only rule",
    );

    expect(loadIdentityContext(dir).assembled).not.toContain("forge-only rule");
    expect(loadIdentityContext(dir, "sage").assembled).not.toContain(
      "forge-only rule",
    );
    expect(loadIdentityContext(dir, "forge").assembled).toContain(
      "forge-only rule",
    );
  });

  it("treats a blank file the same as a missing one", () => {
    const dir = mkTempIdentityDir();
    fs.writeFileSync(path.join(dir, "SOUL.md"), "   \n  ");
    const result = loadIdentityContext(dir);
    const soul = result.sections.find((s) => s.name === "SOUL")!;
    expect(soul.present).toBe(true);
    expect(soul.content).toBe("");
    // Present-but-empty sections are also omitted from the assembled text.
    expect(result.assembled).toBe("");
  });
});
