import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as tar from "tar";
import { extractTarGz } from "./extractor.js";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-extractor-test-"));
}

describe("extractTarGz", () => {
  it("extracts regular files after stripping the archive root", async () => {
    const root = temporaryDirectory();
    const source = path.join(root, "package");
    const destination = path.join(root, "destination");
    const archive = path.join(root, "package.tgz");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "plugin.json"), '{"name":"safe"}');

    try {
      await tar.c({ file: archive, gzip: true, cwd: root }, ["package"]);
      const extracted = await extractTarGz(archive, destination);

      expect(extracted).toContain(path.join(destination, "plugin.json"));
      expect(
        fs.readFileSync(path.join(destination, "plugin.json"), "utf8"),
      ).toBe('{"name":"safe"}');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlink entries", async () => {
    const root = temporaryDirectory();
    const source = path.join(root, "package");
    const destination = path.join(root, "destination");
    const archive = path.join(root, "package.tgz");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "plugin.json"), '{"name":"unsafe"}');
    fs.writeFileSync(path.join(root, "outside.txt"), "outside");
    fs.symlinkSync(
      path.join(root, "outside.txt"),
      path.join(source, "link.txt"),
    );

    try {
      await tar.c({ file: archive, gzip: true, cwd: root }, ["package"]);
      await expect(extractTarGz(archive, destination)).rejects.toThrow(
        /links are not allowed/,
      );
      expect(fs.existsSync(path.join(root, "link.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
