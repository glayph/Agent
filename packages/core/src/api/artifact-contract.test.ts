import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildArtifactManifest,
  detectArtifactContract,
  verifyArtifactContract,
  writeArtifactManifest,
} from "./artifact-contract.js";

describe("artifact contract", () => {
  it("detects Bengali landing-page intent and roots it in the workspace", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-artifact-"));
    const contract = detectArtifactContract("আমার workspace-এ একটি responsive ল্যান্ডিং পেজ তৈরি করো", workspace);

    expect(contract?.root).toBe(path.resolve(workspace));
    expect(contract?.required).toEqual(["index.html"]);
  });

  it("does not report an empty or invalid index as completed", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-artifact-"));
    fs.writeFileSync(path.join(workspace, "index.html"), "placeholder", "utf8");
    const contract = { root: workspace, required: ["index.html"], label: "landing page" };

    expect(verifyArtifactContract(contract)).toEqual({
      ok: false,
      missing: [],
      invalid: ["index.html"],
    });
  });

  it("writes a file inventory with checksums and excludes the manifest itself", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miki-artifact-"));
    fs.writeFileSync(path.join(workspace, "index.html"), "<!doctype html><html><body>ok</body></html>", "utf8");
    fs.mkdirSync(path.join(workspace, ".trash"));
    fs.writeFileSync(path.join(workspace, ".trash", "old.txt"), "quarantine", "utf8");
    const contract = { root: workspace, required: ["index.html"], label: "landing page" };

    const manifestPath = writeArtifactManifest(contract);
    const manifest = buildArtifactManifest(contract);
    expect(manifestPath).toBe(path.join(workspace, "MANIFEST.json"));
    expect(manifest.files.map((entry) => entry.path)).toEqual(["index.html"]);
    expect(manifest.files[0].sha256).toHaveLength(64);
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).schemaVersion).toBe(1);
  });
});
