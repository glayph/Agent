import { normalizeBrowserUrl } from "./browser.js";
import { normalizeHotkeyForSendKeys } from "./computer.js";
import { ToolRegistrySchemas } from "./registry/executor.js";

describe("computer-use tools", () => {
  it("normalizes browser URLs and rejects unsafe protocols", () => {
    expect(normalizeBrowserUrl("example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(normalizeBrowserUrl("http://localhost:3000/")).toBe(
      "http://localhost:3000/",
    );
    expect(() => normalizeBrowserUrl("javascript:alert(1)")).toThrow(
      "Unsupported browser URL protocol",
    );
    expect(() => normalizeBrowserUrl("file:///C:/secret.txt")).toThrow(
      "Unsupported browser URL protocol",
    );
    expect(() => normalizeBrowserUrl("ftp://example.com")).toThrow(
      "Browser URL must use http:// or https://",
    );
  });

  it("normalizes common keyboard shortcuts for the mouse-free backend", () => {
    expect(normalizeHotkeyForSendKeys("Ctrl+S")).toBe("^S");
    expect(normalizeHotkeyForSendKeys(["Ctrl", "Shift", "P"])).toBe("^+P");
    expect(normalizeHotkeyForSendKeys("Alt+F4")).toBe("%{F4}");
    expect(normalizeHotkeyForSendKeys("Enter")).toBe("{ENTER}");
  });

  it("draws PNG grid overlay cleanly", () => {
    const { drawGridOverlay } = require("./computer-grid.js");
    const width = 200;
    const height = 100;
    const rgba = Buffer.alloc(width * height * 4);
    const png = drawGridOverlay(rgba, width, height, 50);
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(0);
    // Check PNG magic header [137, 80, 78, 71]
    expect(png[0]).toBe(137);
    expect(png[1]).toBe(80);
    expect(png[2]).toBe(78);
    expect(png[3]).toBe(71);
  });

  it("exposes mouse-free computer and semantic browser schemas", () => {
    const toolNames = [
      ...ToolRegistrySchemas.browserSchemas(),
      ...ToolRegistrySchemas.computerSchemas(),
    ].map((tool) => tool.function.name);

    expect(toolNames).toEqual(
      expect.arrayContaining([
        "browser_invoke",
        "browser_fill",
        "browser_press",
        "computer_observe",
        "computer_focus",
        "computer_invoke",
        "computer_set_text",
        "computer_hotkey",
        "computer_clipboard",
        "computer_launch",
        "computer_verify",
      ]),
    );
  });
});
