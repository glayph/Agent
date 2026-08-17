import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { validatePluginManifest } from "../../utils/validator";

function createTempDir() {
  const dir = path.join(os.tmpdir(), `validator-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function removeTempDir(dir: string) {
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

describe("validatePluginManifest", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  it("rejects null manifest", async () => {
    const result = await validatePluginManifest(null, tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Manifest must be a non-null object");
  });

  it("rejects non-object manifest", async () => {
    const result = await validatePluginManifest("string", tmpDir);
    expect(result.valid).toBe(false);
  });

  it("requires non-empty name", async () => {
    const result = await validatePluginManifest(
      { name: "", version: "1.0.0", description: "test" },
      tmpDir,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("non-empty"))).toBe(true);
  });

  it("requires description", async () => {
    const result = await validatePluginManifest(
      { name: "my-plugin", version: "1.0.0" },
      tmpDir,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Manifest must have a string "description" field',
    );
  });

  it("rejects whitespace-only description", async () => {
    const result = await validatePluginManifest(
      { name: "my_plugin", version: "1.0.0", description: "   " },
      tmpDir,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Manifest "description" must not be empty');
  });

  it("rejects names with path separators", async () => {
    const result = await validatePluginManifest(
      { name: "../my_plugin", version: "1.0.0", description: "test" },
      tmpDir,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("path separators"))).toBe(true);
  });

  it("rejects reserved tool names", async () => {
    const result = await validatePluginManifest(
      { name: "shell_execute", version: "1.0.0", description: "test" },
      tmpDir,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("reserved"))).toBe(true);
  });

  it("passes valid minimal manifest", async () => {
    const result = await validatePluginManifest(
      { name: "my_plugin", version: "1.0.0", description: "A test plugin" },
      tmpDir,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest?.name).toBe("my_plugin");
    expect(result.manifest?.version).toBe("1.0.0");
    expect(result.manifest?.description).toBe("A test plugin");
  });

  it("accepts marketplace contracts and permission declarations", async () => {
    fs.mkdirSync(path.join(tmpDir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "export {};");
    fs.writeFileSync(path.join(tmpDir, "tools", "github.ts"), "export {};");

    const result = await validatePluginManifest(
      {
        name: "github_ops",
        version: "1.0.0",
        description: "GitHub workflow tools and channel hooks",
        permissions: ["network.http", "secrets.github"],
        contracts: {
          tools: [
            {
              name: "github_pr_review",
              description: "Review a pull request",
              entrypoint: "tools/github.ts",
              permissions: ["network.http"],
              configSchema: { type: "object" },
              metadata: { category: "github" },
            },
          ],
          channels: [{ name: "ms_teams", description: "Teams bot channel" }],
          skills: [{ name: "repo_review" }],
        },
        plugin: {
          entrypoint: "index.ts",
          permissions: ["fs.read"],
          contracts: {
            hooks: [{ name: "after_run", entrypoint: "index.ts" }],
          },
        },
      },
      tmpDir,
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest?.permissions).toEqual([
      "network.http",
      "secrets.github",
    ]);
    expect(result.manifest?.contracts?.tools?.[0]?.name).toBe(
      "github_pr_review",
    );
    expect(result.manifest?.contracts?.channels?.[0]?.name).toBe("ms_teams");
    expect(result.manifest?.plugin?.contracts?.hooks?.[0]?.name).toBe(
      "after_run",
    );
  });

  it("rejects malformed contract blocks", async () => {
    const result = await validatePluginManifest(
      {
        name: "bad_contracts",
        version: "1.0.0",
        description: "test",
        contracts: {
          tools: { name: "not_an_array" },
        },
      },
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("tools must be an array")),
    ).toBe(true);
  });

  it("rejects duplicate and reserved tool contract names", async () => {
    const result = await validatePluginManifest(
      {
        name: "bad_tools",
        version: "1.0.0",
        description: "test",
        contracts: {
          tools: [
            { name: "custom_tool" },
            { name: "custom_tool" },
            { name: "shell_execute" },
          ],
        },
      },
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate contract"))).toBe(
      true,
    );
    expect(result.errors.some((e) => e.includes("reserved"))).toBe(true);
  });

  it("rejects unsafe contract permissions and entrypoints", async () => {
    const result = await validatePluginManifest(
      {
        name: "bad_contract_paths",
        version: "1.0.0",
        description: "test",
        contracts: {
          tools: [
            {
              name: "unsafe_tool",
              entrypoint: "../outside.ts",
              permissions: ["Network.HTTP"],
            },
          ],
        },
      },
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("inside the plugin files directory"),
      ),
    ).toBe(true);
    expect(result.errors.some((e) => e.includes("lowercase permission"))).toBe(
      true,
    );
  });

  it("warns on non-semver version", async () => {
    const result = await validatePluginManifest(
      { name: "my_plugin", version: "1.0", description: "test" },
      tmpDir,
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("semver"))).toBe(true);
  });

  it("warns on non-snake_case name", async () => {
    const result = await validatePluginManifest(
      { name: "My-Plugin", version: "1.0.0", description: "test" },
      tmpDir,
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("snake_case"))).toBe(true);
  });

  it("validates entrypoint existence", async () => {
    fs.writeFileSync(path.join(tmpDir, "index.py"), "# test");
    const result = await validatePluginManifest(
      {
        name: "my_plugin",
        version: "1.0.0",
        description: "test",
        main: "index.py",
      },
      tmpDir,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects missing entrypoint", async () => {
    const result = await validatePluginManifest(
      {
        name: "my_plugin",
        version: "1.0.0",
        description: "test",
        main: "nonexistent.py",
      },
      tmpDir,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("does not exist"))).toBe(true);
  });

  it("rejects entrypoints outside plugin files directory", async () => {
    const outsidePath = path.join(tmpDir, "..", "outside.py");
    fs.writeFileSync(outsidePath, "# test");
    const result = await validatePluginManifest(
      {
        name: "my_plugin",
        version: "1.0.0",
        description: "test",
        main: "../outside.py",
      },
      tmpDir,
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("inside the plugin files directory"),
      ),
    ).toBe(true);
  });

  it("rejects absolute entrypoints", async () => {
    const entryPath = path.join(tmpDir, "index.py");
    fs.writeFileSync(entryPath, "# test");
    const result = await validatePluginManifest(
      {
        name: "my_plugin",
        version: "1.0.0",
        description: "test",
        main: entryPath,
      },
      tmpDir,
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("inside the plugin files directory"),
      ),
    ).toBe(true);
  });

  it("rejects non-object plugin blocks", async () => {
    const result = await validatePluginManifest(
      {
        name: "my_plugin",
        version: "1.0.0",
        description: "test",
        plugin: "invalid",
      },
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('"plugin" must be an object')),
    ).toBe(true);
  });

  it("rejects unsupported entrypoint extensions", async () => {
    fs.writeFileSync(path.join(tmpDir, "install.sh"), "#!/bin/sh");
    const result = await validatePluginManifest(
      {
        name: "my_plugin",
        version: "1.0.0",
        description: "test",
        main: "install.sh",
      },
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("must use one of"))).toBe(true);
  });

  it("rejects symlinked entrypoints that resolve outside plugin files", async () => {
    const outsideDir = path.join(tmpDir, "..", `outside-${Date.now()}`);
    const outsidePath = path.join(outsideDir, "entry.py");
    const linkPath = path.join(tmpDir, "entry.py");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsidePath, "# outside");

    try {
      fs.symlinkSync(outsidePath, linkPath);
    } catch {
      return;
    }

    const result = await validatePluginManifest(
      {
        name: "my_plugin",
        version: "1.0.0",
        description: "test",
        main: "entry.py",
      },
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("must resolve inside"))).toBe(
      true,
    );
  });
});
