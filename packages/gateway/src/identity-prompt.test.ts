import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildIdentityContext } from "./identity-prompt.js";

describe("identity prompt cache", () => {
  it("reuses unchanged identity text and refreshes it when a file changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-identity-prompt-"));
    const file = path.join(dir, "SOUL.md");
    const input = { groups: [{ key: "filesystem", enabled: true }], identityDirs: [dir] };
    try {
      fs.writeFileSync(file, "first identity version");
      expect(buildIdentityContext(input)).toContain("first identity version");
      fs.writeFileSync(file, "updated identity version with a different size");
      expect(buildIdentityContext(input)).toContain("updated identity version with a different size");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
