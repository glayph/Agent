import { readZip, ZipError, isZip } from "./zip.js";
import { makeZip } from "./__tests__/zip-fixture.js";

describe("readZip", () => {
  it("reads stored and deflated entries and skips directories and __MACOSX", () => {
    const zip = makeZip([
      { name: "demo/" },
      { name: "demo/SKILL.md", data: "hello", deflate: true },
      { name: "demo/scripts/run.py", data: "print(1)" },
      { name: "__MACOSX/demo/._SKILL.md", data: "junk" },
    ]);
    expect(isZip(zip)).toBe(true);
    const files = readZip(zip);
    expect(files.map((file) => file.path)).toEqual([
      "demo/SKILL.md",
      "demo/scripts/run.py",
    ]);
    expect(files[0].data.toString()).toBe("hello");
  });

  it.each([
    ["path traversal", [{ name: "../evil.txt", data: "x" }]],
    ["absolute path", [{ name: "/etc/passwd", data: "x" }]],
    ["windows drive path", [{ name: "C:/evil.txt", data: "x" }]],
    ["symbolic link", [{ name: "link", data: "/etc/passwd", mode: 0o120777 }]],
    ["encrypted entry", [{ name: "a.txt", data: "x", encrypted: true }]],
    [
      "duplicate entry",
      [
        { name: "a.txt", data: "x" },
        { name: "a.txt", data: "y" },
      ],
    ],
  ])("rejects %s", (_label, entries) => {
    expect(() => readZip(makeZip(entries))).toThrow(ZipError);
  });

  it("enforces size and entry limits", () => {
    const zip = makeZip([
      { name: "a.txt", data: "12345" },
      { name: "b.txt", data: "12345" },
    ]);
    expect(() =>
      readZip(zip, { maxEntries: 1, maxTotalBytes: 100, maxFileBytes: 100 }),
    ).toThrow(/more than/);
    expect(() =>
      readZip(zip, { maxEntries: 5, maxTotalBytes: 8, maxFileBytes: 100 }),
    ).toThrow(/total size/);
    expect(() =>
      readZip(zip, { maxEntries: 5, maxTotalBytes: 100, maxFileBytes: 3 }),
    ).toThrow(/per-file/);
  });

  it("rejects data that is not a ZIP", () => {
    expect(() =>
      readZip(Buffer.from("not a zip file at all, just text")),
    ).toThrow(ZipError);
  });
});
