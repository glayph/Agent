import { describe, expect, it } from "@jest/globals";
import { normalizeBrowserUrl, rewriteWorkspacePreviewUrl } from "./runtime.js";

describe("browser navigation URL policy", () => {
  it("normalizes hostnames and preserves explicit HTTP(S) URLs", () => {
    expect(normalizeBrowserUrl("example.com/path")).toBe("https://example.com/path");
    expect(normalizeBrowserUrl("http://localhost:3000/")).toBe("http://localhost:3000/");
  });

  it("rejects unsafe and unsupported protocols", () => {
    expect(() => normalizeBrowserUrl("javascript:alert(1)")).toThrow("Unsupported browser URL protocol");
    expect(() => normalizeBrowserUrl("file:///etc/passwd")).toThrow("Unsupported browser URL protocol");
    expect(() => normalizeBrowserUrl("ftp://example.com")).toThrow("Browser URL must use http:// or https://");
  });

  it("rewrites the legacy workspace preview port without altering other hosts", () => {
    expect(rewriteWorkspacePreviewUrl("http://localhost:8765/index.html", 9876)).toBe("http://localhost:9876/index.html");
    expect(rewriteWorkspacePreviewUrl("https://example.com/", 9876)).toBe("https://example.com/");
  });
});
