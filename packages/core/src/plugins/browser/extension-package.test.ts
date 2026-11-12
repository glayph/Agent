import fs from "node:fs";
import path from "node:path";

const extensionRoot = __dirname;
const repositoryRoot = path.resolve(extensionRoot, "../../../../..");
const targets = [
  { name: "chrome", manifest: "manifest.chrome.json" },
  { name: "firefox", manifest: "manifest.firefox.json" },
  { name: "safari", manifest: "manifest.safari.json" },
] as const;

describe("Miki browser extension packages", () => {
  for (const target of targets) {
    it(`has a complete ${target.name} WebExtension bundle`, () => {
      const manifestPath = path.join(extensionRoot, "extension", target.manifest);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        manifest_version: number;
        permissions?: string[];
        background?: Record<string, unknown>;
        content_scripts?: Array<{ js?: string[] }>;
      };
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.permissions).toEqual(expect.arrayContaining(["tabs", "storage"]));
      expect(manifest.background).toBeTruthy();
      expect(manifest.content_scripts?.[0]?.js).toContain("content.js");
      for (const file of ["service-worker.js", "content.js", "popup.html", "popup.js", "options.html", "options.js"]) {
        expect(fs.existsSync(path.join(extensionRoot, "extension", file))).toBe(true);
      }
    });
  }

  it("contains no Playwright runtime or browser installer", () => {
    const root = repositoryRoot;
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const corePackage = JSON.parse(fs.readFileSync(path.join(extensionRoot, "../../../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencyNames = [
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.devDependencies || {}),
      ...Object.keys(corePackage.dependencies || {}),
      ...Object.keys(corePackage.devDependencies || {}),
    ];
    expect(dependencyNames.some((name) => /playwright/i.test(name))).toBe(false);
    expect(Object.values(packageJson.scripts || {}).join("\n")).not.toMatch(/playwright/i);
    expect(fs.existsSync(path.join(root, "scripts", "install-playwright-browser.mjs"))).toBe(false);
  });
});
