import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SkillInstaller } from "../installer/skill-installer";

describe("SkillInstaller.preview", () => {
  let root: string;
  let skillsDir: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-plugin-preview-"));
    skillsDir = path.join(root, "installed");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("previews and installs a native miki.provider.json plugin", async () => {
    const pluginDir = path.join(root, "provider");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "miki.provider.json"),
      JSON.stringify({
        id: "demo-provider",
        displayName: "Demo Provider",
        version: "1.0.0",
        pluginApiVersion: "1.0",
        entrypoint: "index.mjs",
        baseUrl: "https://example.invalid/v1",
        apiKeyEnv: "DEMO_PROVIDER_KEY",
        modelIds: ["demo/fast"],
        permissions: ["network"],
        capabilities: {
          chat: true,
          tools: true,
          streaming: true,
          vision: false,
          local: false,
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.mjs"),
      "export default {};\n",
      "utf8",
    );

    const installer = new SkillInstaller(skillsDir);
    await installer.init();
    const preview = await installer.preview(pluginDir);

    expect(preview).toMatchObject({
      valid: true,
      installability: "installable",
      name: "demo-provider",
      version: "1.0.0",
      entrypoint: "index.mjs",
      runtime: "node",
      sourceProtocol: "local",
    });
    expect(preview.manifest?.plugin?.contracts?.providers?.[0]).toMatchObject({
      name: "demo-provider",
      entrypoint: "index.mjs",
      metadata: expect.objectContaining({
        id: "demo-provider",
        base_url: "https://example.invalid/v1",
        api_key_env: "DEMO_PROVIDER_KEY",
        models: ["demo/fast"],
      }),
    });

    const result = await installer.install(pluginDir);
    expect(result.success).toBe(true);
    expect(result.installability).toBe("installable");
    expect(result.plugin?.contracts?.providers?.[0]?.name).toBe(
      "demo-provider",
    );
  });

  it("distinguishes metadata-only and unsupported-runtime plugins", async () => {
    const metadataOnly = path.join(root, "metadata-only");
    fs.mkdirSync(metadataOnly, { recursive: true });
    fs.writeFileSync(
      path.join(metadataOnly, "miki.provider.json"),
      JSON.stringify({
        id: "metadata-provider",
        displayName: "Metadata Provider",
        version: "1.0.0",
        pluginApiVersion: "1.0",
        capabilities: {
          chat: true,
          tools: false,
          streaming: false,
          vision: false,
          local: false,
        },
      }),
      "utf8",
    );

    const unsupported = path.join(root, "unsupported");
    fs.mkdirSync(unsupported, { recursive: true });
    fs.writeFileSync(
      path.join(unsupported, "plugin.json"),
      JSON.stringify({
        name: "typescript-plugin",
        version: "1.0.0",
        description: "TypeScript source is retained but not directly runnable.",
        main: "index.ts",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(unsupported, "index.ts"),
      "export {};\n",
      "utf8",
    );

    const installer = new SkillInstaller(skillsDir);
    await installer.init();
    await expect(installer.preview(metadataOnly)).resolves.toMatchObject({
      valid: true,
      installability: "metadata_only",
      name: "metadata-provider",
    });
    await expect(installer.preview(unsupported)).resolves.toMatchObject({
      valid: true,
      installability: "unsupported_runtime",
      name: "typescript-plugin",
      entrypoint: "index.ts",
    });
  });
});
