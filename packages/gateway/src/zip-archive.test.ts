import { createZipArchive } from "./zip-archive.js";

describe("createZipArchive", () => {
  it("writes a standard ZIP containing UTF-8 file names and content", () => {
    const zip = createZipArchive([
      { name: "data/example.txt", data: Buffer.from("hello world", "utf8") },
      { name: "notes/বাংলা.txt", data: Buffer.from("backup", "utf8") },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from("data/example.txt", "utf8"))).toBe(true);
    expect(zip.includes(Buffer.from("hello world", "utf8"))).toBe(true);
    expect(zip.includes(Buffer.from("notes/বাংলা.txt", "utf8"))).toBe(true);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });
});
