import { SkillInstaller } from "../../installer/skill-installer";
import { SourceProtocol } from "../../types";
import * as os from "os";
import * as path from "path";

describe("SkillInstaller.parseSpec", () => {
  const installer = new SkillInstaller(path.join(os.tmpdir(), "test-skills"));

  it("parses clawhub:package-name", () => {
    const result = installer.parseSpec("clawhub:my-plugin");
    expect(result.protocol).toBe(SourceProtocol.CLAWHUB);
    expect(result.packageName).toBe("my-plugin");
  });

  it("parses npm:@scope/package-name", () => {
    const result = installer.parseSpec("npm:@scope/my-plugin");
    expect(result.protocol).toBe(SourceProtocol.NPM);
    expect(result.packageName).toBe("@scope/my-plugin");
  });

  it("parses npm:package@version", () => {
    const result = installer.parseSpec("npm:my-plugin@1.2.3");
    expect(result.protocol).toBe(SourceProtocol.NPM);
    expect(result.packageName).toBe("my-plugin");
    expect(result.version).toBe("1.2.3");
  });

  it("parses npm:@scope/pkg@version", () => {
    const result = installer.parseSpec("npm:@scope/pkg@1.0.0");
    expect(result.protocol).toBe(SourceProtocol.NPM);
    expect(result.packageName).toBe("@scope/pkg");
    expect(result.version).toBe("1.0.0");
  });

  it("parses git:github.com/user/repo", () => {
    const result = installer.parseSpec("git:github.com/user/repo");
    expect(result.protocol).toBe(SourceProtocol.GIT);
    expect(result.packageName).toBe("github.com/user/repo");
    expect(result.branch).toBeUndefined();
  });

  it("parses git:github.com/user/repo#branch", () => {
    const result = installer.parseSpec(
      "git:github.com/user/repo#feat/new-thing",
    );
    expect(result.protocol).toBe(SourceProtocol.GIT);
    expect(result.packageName).toBe("github.com/user/repo");
    expect(result.branch).toBe("feat/new-thing");
  });

  it("parses ./relative-path", () => {
    const result = installer.parseSpec("./my-local-plugin");
    expect(result.protocol).toBe(SourceProtocol.LOCAL);
    expect(result.packageName).toBe("./my-local-plugin");
  });

  it("parses /absolute/path", () => {
    const result = installer.parseSpec("/home/user/my-plugin");
    expect(result.protocol).toBe(SourceProtocol.LOCAL);
    expect(result.packageName).toBe("/home/user/my-plugin");
  });

  it("parses Windows absolute path C:\\Users\\...", () => {
    const result = installer.parseSpec("C:\\Users\\me\\plugin");
    expect(result.protocol).toBe(SourceProtocol.LOCAL);
    expect(result.packageName).toBe("C:\\Users\\me\\plugin");
  });

  it("defaults unknown format to LOCAL", () => {
    const result = installer.parseSpec("some-random-string");
    expect(result.protocol).toBe(SourceProtocol.LOCAL);
    expect(result.packageName).toBe("some-random-string");
  });
});
