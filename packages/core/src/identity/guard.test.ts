import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isSoulProtectedPath } from "./guard.js";

function mkTempIdentityDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-identity-guard-"));
}

describe("isSoulProtectedPath", () => {
  it("matches SOUL.md whether the candidate path is absolute or relative-then-resolved", () => {
    const dir = mkTempIdentityDir();
    const soulPath = path.join(dir, "SOUL.md");
    fs.writeFileSync(soulPath, "core values");

    expect(isSoulProtectedPath(soulPath, dir)).toBe(true);
    expect(isSoulProtectedPath(path.join(dir, "./SOUL.md"), dir)).toBe(true);
  });

  it("does not match other identity files or lookalike names", () => {
    const dir = mkTempIdentityDir();
    expect(isSoulProtectedPath(path.join(dir, "AGENTS.md"), dir)).toBe(false);
    expect(isSoulProtectedPath(path.join(dir, "SOUL.md.bak"), dir)).toBe(false);
    expect(isSoulProtectedPath(path.join(dir, "notSOUL.md"), dir)).toBe(false);
  });

  it("matches even when SOUL.md does not exist on disk yet (protects creation too)", () => {
    const dir = mkTempIdentityDir();
    expect(fs.existsSync(path.join(dir, "SOUL.md"))).toBe(false);
    expect(isSoulProtectedPath(path.join(dir, "SOUL.md"), dir)).toBe(true);
  });

  it("returns false when no identity directory is configured", () => {
    expect(isSoulProtectedPath("/anywhere/SOUL.md", null)).toBe(false);
    expect(isSoulProtectedPath("/anywhere/SOUL.md", undefined)).toBe(false);
    expect(isSoulProtectedPath("/anywhere/SOUL.md", "")).toBe(false);
  });
});
