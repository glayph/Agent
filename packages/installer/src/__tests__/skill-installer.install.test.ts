import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SkillInstaller } from "../installer/skill-installer";

describe("SkillInstaller.install", () => {
  let tmpDir: string;
  let skillsDir: string;
  let pluginDir: string;
  let installer: SkillInstaller;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `installer-install-test-${Date.now()}`);
    skillsDir = path.join(tmpDir, "skills");
    pluginDir = path.join(tmpDir, "plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.ts"), "export {};", "utf-8");

    fs.writeFileSync(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "contract_plugin",
        version: "1.0.0",
        description: "Plugin with marketplace contracts",
        author: "Hiro",
        license: "MIT",
        permissions: ["network.http"],
        contracts: {
          tools: [
            {
              name: "contract_tool",
              entrypoint: "index.ts",
              permissions: ["secrets.github"],
            },
          ],
        },
        plugin: {
          entrypoint: "index.ts",
          permissions: ["fs.read"],
          contracts: {
            hooks: [{ name: "after_run", entrypoint: "index.ts" }],
          },
        },
      }),
      "utf-8",
    );

    installer = new SkillInstaller(skillsDir);
    await installer.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists validated plugin contracts into installed state", async () => {
    const result = await installer.install(pluginDir);

    expect(result.success).toBe(true);
    expect(result.name).toBe("contract_plugin");
    expect(result.assetsPath).toBeDefined();
    expect(fs.existsSync(path.join(result.assetsPath!, "index.ts"))).toBe(true);
    expect(result.permissions).toEqual(["network.http"]);
    expect(result.contracts?.tools?.[0]?.name).toBe("contract_tool");

    const installed = await installer.getRegistry().getSkill("contract_plugin");
    expect(installed?.description).toBe("Plugin with marketplace contracts");
    expect(installed?.author).toBe("Hiro");
    expect(installed?.license).toBe("MIT");
    expect(installed?.assetsPath).toBe(result.assetsPath);
    expect(installed?.permissions).toEqual(["network.http"]);
    expect(installed?.contracts?.tools?.[0]?.name).toBe("contract_tool");
    expect(installed?.plugin?.contracts?.hooks?.[0]?.name).toBe("after_run");

    const catalog = await installer.getRegistry().listPluginContracts();
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tools",
          plugin: expect.objectContaining({ name: "contract_plugin" }),
          contract: expect.objectContaining({ name: "contract_tool" }),
          permissions: ["network.http", "secrets.github"],
        }),
        expect.objectContaining({
          kind: "hooks",
          contract: expect.objectContaining({ name: "after_run" }),
          permissions: ["network.http", "fs.read"],
        }),
      ]),
    );
  });
});
