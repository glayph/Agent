import { normalizeBrowserUrl } from "../browser/runtime.js";
import {
  ComputerAgent,
  linuxX11UnavailableReason,
  normalizeHotkeyForSendKeys,
  normalizeHotkeyForXdotool,
} from "./runtime.js";
import { drawGridOverlay } from "./grid.js";

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

  it("reports headless and Wayland-only Linux sessions as unsupported for UI actions", () => {
    expect(linuxX11UnavailableReason({})).toMatch(/DISPLAY is unset/);
    expect(linuxX11UnavailableReason({ WAYLAND_DISPLAY: "wayland-0" })).toMatch(
      /Wayland-only/,
    );
    expect(
      linuxX11UnavailableReason({
        DISPLAY: ":1",
        WAYLAND_DISPLAY: "wayland-0",
      }),
    ).toBeNull();
  });

  it("reports Linux desktop capabilities as unavailable when there is no display session", async () => {
    if (process.platform !== "linux") return;
    const previousDisplay = process.env.DISPLAY;
    const previousWayland = process.env.WAYLAND_DISPLAY;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      const result = JSON.parse(await new ComputerAgent().getCapabilities()) as {
        ok?: boolean;
        data?: { actions?: Record<string, boolean>; limitations?: string[]; backend?: string };
      };
      expect(result.ok).toBe(true);
      expect(result.data?.backend).toBe("linux-x11-coordinate-window-metadata");
      expect(result.data?.actions?.screenshot).toBe(false);
      expect(result.data?.actions?.clickAt).toBe(false);
      expect(result.data?.limitations?.join(" ")).toMatch(/DISPLAY is unset/);
    } finally {
      if (previousDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = previousDisplay;
      if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = previousWayland;
    }
  });

  it("normalizes safe X11 shortcuts and rejects command-like key names", () => {
    expect(normalizeHotkeyForXdotool(["Ctrl", "Shift", "P"])).toBe(
      "ctrl+shift+P",
    );
    expect(normalizeHotkeyForXdotool("Alt+F4")).toBe("alt+F4");
    expect(normalizeHotkeyForXdotool("Enter")).toBe("Return");
    expect(() => normalizeHotkeyForXdotool("Ctrl;reboot")).toThrow(
      /Unsupported X11 shortcut key/,
    );
  });

  it("draws PNG grid overlay cleanly", () => {
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
});
