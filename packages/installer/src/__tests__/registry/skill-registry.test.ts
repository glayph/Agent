import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SkillRegistry } from "../../registry/skill-registry";
import { SourceProtocol } from "../../types";

function createTempDir() {
  const dir = path.join(os.tmpdir(), `skill-registry-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("SkillRegistry", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    statePath = path.join(tmpDir, ".plugin-registry.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("filters malformed persisted skills", async () => {
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        skills: [
          {
            name: "valid_skill",
            version: "1.0.0",
            description: "Valid skill",
            source: path.join(tmpDir, "valid_skill.ts"),
            sourceProtocol: SourceProtocol.LOCAL,
            installedAt: new Date().toISOString(),
            path: path.join(tmpDir, "valid_skill.ts"),
            entrypoint: "valid_skill.ts",
          },
          {
            name: "../invalid_skill",
            version: "1.0.0",
            description: "Invalid skill",
            source: path.join(tmpDir, "invalid_skill.ts"),
            sourceProtocol: SourceProtocol.LOCAL,
            installedAt: new Date().toISOString(),
            path: path.join(tmpDir, "invalid_skill.ts"),
            entrypoint: "invalid_skill.ts",
          },
          {
            name: "bad_protocol",
            version: "1.0.0",
            description: "Invalid protocol",
            source: path.join(tmpDir, "bad_protocol.ts"),
            sourceProtocol: "ftp",
            installedAt: new Date().toISOString(),
            path: path.join(tmpDir, "bad_protocol.ts"),
            entrypoint: "bad_protocol.ts",
          },
        ],
      }),
      "utf-8",
    );

    const registry = new SkillRegistry(tmpDir, statePath);
    await registry.init();

    expect(await registry.listInstalled()).toEqual([
      expect.objectContaining({ name: "valid_skill" }),
    ]);
  });

  it("returns defensive copies of installed skill records", async () => {
    const registry = new SkillRegistry(tmpDir, statePath);
    await registry.init();
    await registry.register({
      success: true,
      name: "copy_safe",
      version: "1.0.0",
      path: path.join(tmpDir, "copy_safe.ts"),
      action: "installed",
      permissions: ["network.http"],
      contracts: {
        tools: [{ name: "copy_tool", permissions: ["fs.read"] }],
      },
    });

    const listed = await registry.listInstalled();
    listed[0].version = "999.0.0";
    listed[0].contracts!.tools![0].name = "mutated_tool";
    const fetched = await registry.getSkill("copy_safe");
    expect(fetched?.version).toBe("1.0.0");
    expect(fetched?.contracts?.tools?.[0]?.name).toBe("copy_tool");

    if (!fetched) throw new Error("Expected installed skill");
    fetched.version = "888.0.0";
    fetched.contracts!.tools![0].name = "another_mutation";
    expect((await registry.getSkill("copy_safe"))?.version).toBe("1.0.0");
    expect(
      (await registry.getSkill("copy_safe"))?.contracts?.tools?.[0]?.name,
    ).toBe("copy_tool");
  });

  it("persists plugin contract metadata and lists a runtime catalog", async () => {
    const registry = new SkillRegistry(tmpDir, statePath);
    await registry.init();

    await registry.register({
      success: true,
      name: "github_ops",
      version: "1.0.0",
      path: path.join(tmpDir, "github_ops.ts"),
      action: "installed",
      description: "GitHub operations",
      author: "Hiro",
      license: "MIT",
      permissions: ["network.http"],
      contracts: {
        tools: [
          {
            name: "github_pr_review",
            description: "Review a pull request",
            permissions: ["secrets.github"],
          },
        ],
        channels: [{ name: "ms_teams" }],
      },
      plugin: {
        permissions: ["fs.read"],
        contracts: {
          hooks: [{ name: "after_run", permissions: ["audit.write"] }],
        },
      },
    });

    const reloaded = new SkillRegistry(tmpDir, statePath);
    await reloaded.init();

    const installed = await reloaded.getSkill("github_ops");
    expect(installed?.description).toBe("GitHub operations");
    expect(installed?.author).toBe("Hiro");
    expect(installed?.contracts?.tools?.[0]?.name).toBe("github_pr_review");
    expect(installed?.plugin?.contracts?.hooks?.[0]?.name).toBe("after_run");

    const catalog = await reloaded.listPluginContracts();
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tools",
          plugin: expect.objectContaining({ name: "github_ops" }),
          contract: expect.objectContaining({ name: "github_pr_review" }),
          permissions: ["network.http", "secrets.github"],
        }),
        expect.objectContaining({
          kind: "hooks",
          contract: expect.objectContaining({ name: "after_run" }),
          permissions: ["network.http", "fs.read", "audit.write"],
        }),
      ]),
    );

    const channelCatalog = await reloaded.listPluginContracts("channels");
    expect(channelCatalog).toHaveLength(1);
    expect(channelCatalog[0].contract.name).toBe("ms_teams");
  });

  it("rejects unsafe names during registration", async () => {
    const registry = new SkillRegistry(tmpDir, statePath);
    await registry.init();

    await expect(
      registry.register({
        success: true,
        name: "../unsafe",
        version: "1.0.0",
        path: path.join(tmpDir, "unsafe.ts"),
        action: "installed",
      }),
    ).rejects.toThrow("Invalid skill name");
  });
});
