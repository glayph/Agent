import { getLinkPreview } from "./link-preview.js";

describe("link preview safety", () => {
  it("rejects non-HTTP(S) URLs", async () => {
    await expect(getLinkPreview("file:///etc/passwd")).rejects.toThrow(
      /HTTP\(S\)/,
    );
  });

  it("rejects loopback and cloud-metadata addresses", async () => {
    await expect(getLinkPreview("http://127.0.0.1/health")).rejects.toThrow(
      /private network/i,
    );
    await expect(
      getLinkPreview("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/private network/i);
  });

  it("rejects URLs containing embedded credentials", async () => {
    await expect(
      getLinkPreview("https://user:password@example.com/"),
    ).rejects.toThrow(/embedded credentials/i);
  });
});
