import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fetchSkill } from "../../source-dispatch";
import { SourceProtocol } from "../../types";

describe("fetchSkill local", () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    srcDir = path.join(os.tmpdir(), `local-src-${Date.now()}`);
    destDir = path.join(os.tmpdir(), `local-dest-${Date.now()}`);
    fs.mkdirSync(srcDir, { recursive: true });

    const manifest = {
      name: "local_test_plugin",
      version: "0.1.0",
      description: "A test plugin",
      permissions: ["network.http"],
      contracts: {
        tools: [{ name: "local_tool", entrypoint: "local_test_plugin.py" }],
        channels: [{ name: "local_channel" }],
      },
      plugin: { entrypoint: "local_test_plugin.py" },
    };

    fs.writeFileSync(
      path.join(srcDir, "plugin.json"),
      JSON.stringify(manifest),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(srcDir, "local_test_plugin.py"),
      'def execute():\n    return "ok"\n',
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  it("copies local plugin and returns manifest and entrypoint", async () => {
    const result = await fetchSkill(
      SourceProtocol.LOCAL,
      { protocol: SourceProtocol.LOCAL, packageName: srcDir },
      destDir,
    );

    expect(result).toBeDefined();
    expect(result.manifest).toBeDefined();
    expect(result.manifest.name).toBe("local_test_plugin");
    expect(result.manifest.permissions).toEqual(["network.http"]);
    expect(result.manifest.contracts?.tools?.[0]?.name).toBe("local_tool");
    expect(result.manifest.contracts?.channels?.[0]?.name).toBe(
      "local_channel",
    );
    expect(result.entrypoint).toBe("local_test_plugin.py");

    const entryPath = path.join(result.filesDir, result.entrypoint);
    expect(fs.existsSync(entryPath)).toBe(true);
  });
});
