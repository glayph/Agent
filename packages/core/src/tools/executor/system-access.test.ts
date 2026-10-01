import fs from "fs";
import os from "os";
import path from "path";
import {
  loadSystemAccessMode,
  modeEnforcesBoundary,
  parseSystemAccessMode,
} from "./system-access.js";

function configDirWith(yamlText?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-sysaccess-"));
  if (yamlText !== undefined)
    fs.writeFileSync(path.join(dir, "agent.yaml"), yamlText, "utf-8");
  return dir;
}

describe("system access mode", () => {
  it("defaults to full when agent.yaml is missing, unreadable, or unset", () => {
    expect(loadSystemAccessMode(configDirWith())).toBe("full");
    expect(loadSystemAccessMode(configDirWith("agent: [broken"))).toBe("full");
    expect(loadSystemAccessMode(configDirWith("agent:\n  name: Miki\n"))).toBe(
      "full",
    );
  });

  it("reads an explicit operator restriction", () => {
    const dir = configDirWith(
      "agent:\n  security:\n    system_access: workspace_only\n",
    );
    expect(loadSystemAccessMode(dir)).toBe("workspace_only");
  });

  it("treats unknown values as full and only non-full modes confine", () => {
    expect(parseSystemAccessMode("bogus")).toBe("full");
    expect(modeEnforcesBoundary("full")).toBe(false);
    expect(modeEnforcesBoundary("workspace_only")).toBe(true);
    expect(modeEnforcesBoundary("isolated")).toBe(true);
  });

  it("the shipped config/agent.yaml is systemwide", () => {
    const shipped = path.resolve(process.cwd(), "config");
    if (!fs.existsSync(path.join(shipped, "agent.yaml"))) return;
    expect(loadSystemAccessMode(shipped)).toBe("full");
  });
});
