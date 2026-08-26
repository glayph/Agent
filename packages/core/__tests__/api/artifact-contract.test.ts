import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectArtifactContract,
  verifyArtifactContract,
} from "../../src/api/artifact-contract.js";

describe("artifact contract validation", () => {
  it("requires both index.html and styles.css for a static landing-page request", () => {
    const contract = detectArtifactContract(
      "Build a polished static Hello World landing page in /tmp/miki-landing with index.html and styles.css.",
    );
    expect(contract).toEqual({
      root: "/tmp/miki-landing",
      required: ["index.html", "styles.css"],
      label: "landing page",
    });
  });

  it("does not claim completion while a required file is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-artifact-"));
    const contract = {
      root,
      required: ["index.html", "styles.css"],
      label: "landing page",
    };
    fs.writeFileSync(path.join(root, "index.html"), "<main>Hello</main>");
    expect(verifyArtifactContract(contract)).toEqual({
      ok: false,
      missing: ["styles.css"],
      invalid: [],
    });
  });

  it("accepts a contract only when every required file is non-empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-artifact-"));
    const contract = {
      root,
      required: ["index.html", "styles.css"],
      label: "landing page",
    };
    fs.writeFileSync(path.join(root, "index.html"), "<main>Hello</main>");
    fs.writeFileSync(path.join(root, "styles.css"), "body { color: red; }");
    expect(verifyArtifactContract(contract)).toEqual({
      ok: true,
      missing: [],
      invalid: [],
    });
  });
});
