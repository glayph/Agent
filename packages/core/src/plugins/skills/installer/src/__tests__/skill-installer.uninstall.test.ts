import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SkillInstaller } from "../installer/skill-installer.js";
import { InstallResult } from "../types.js";

describe("SkillInstaller.uninstall", () => {
  let tmpDir: string;
  let installer: SkillInstaller;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `installer-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    installer = new SkillInstaller(tmpDir);
    await installer.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses unsafe paths and retains the registry record when files cannot be moved", async () => {
    const skillPath = path.join(tmpDir, "my_plugin.ts");
    fs.writeFileSync(skillPath, "// dummy plugin", "utf-8");
    const result = {
      success: true,
      name: "my_plugin",
      version: "1.0.0",
      path: path.join(tmpDir, "..", "outside.ts"),
      action: "installed",
    };
    await installer.getRegistry().register(result as unknown as InstallResult);
    await expect(installer.uninstall("my_plugin")).rejects.toThrow(/outside its managed directory/i);
    expect(await installer.getRegistry().isInstalled("my_plugin")).toBe(true);
  });


  it("restores skill files when the registry refuses removal", async () => {
    const skillPath = path.join(tmpDir, "my_plugin.ts");
    fs.writeFileSync(skillPath, "// dummy plugin", "utf-8");
    const result = {
      success: true,
      name: "my_plugin",
      version: "1.0.0",
      path: skillPath,
      action: "installed",
    };
    await installer.getRegistry().register(result as unknown as InstallResult);

    const registry = installer.getRegistry() as unknown as { remove: (name: string) => Promise<boolean> };
    const originalRemove = registry.remove.bind(registry);
    registry.remove = async () => { throw new Error("registry_write_failed"); };
    await expect(installer.uninstall("my_plugin")).rejects.toThrow("registry_write_failed");
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(await installer.getRegistry().isInstalled("my_plugin")).toBe(true);
    registry.remove = originalRemove;
  });

  it("removes skill files and unregisters from registry", async () => {
    const skillPath = path.join(tmpDir, "my_plugin.ts");
    fs.writeFileSync(skillPath, "// dummy plugin", "utf-8");

    const result = {
      success: true,
      name: "my_plugin",
      version: "1.0.0",
      path: skillPath,
      action: "installed",
    };

    await installer.getRegistry().register(result as unknown as InstallResult);

    expect(fs.existsSync(skillPath)).toBe(true);
    expect(await installer.getRegistry().isInstalled("my_plugin")).toBe(true);

    const uninstalled = await installer.uninstall("my_plugin");
    expect(uninstalled).toBe(true);
    expect(fs.existsSync(skillPath)).toBe(false);
    expect(await installer.getRegistry().isInstalled("my_plugin")).toBe(false);
  });
});
