import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeBrowserUrl } from "../browser/runtime.js";
import {
  ComputerAgent,
  linuxX11UnavailableReason,
  normalizeHotkeyForSendKeys,
  normalizeHotkeyForXdotool,
  parseDesktopApplication,
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

  it("parses desktop application entries without shell interpretation", () => {
    const app = parseDesktopApplication([
      "[Desktop Entry]", "Type=Application", "Name=Example Editor",
      "Exec=/usr/bin/example-editor --open %U", "Terminal=false",
    ].join("\n"), "/usr/share/applications/example-editor.desktop");
    expect(app).toMatchObject({
      id: "example-editor", name: "Example Editor",
      command: "/usr/bin/example-editor", args: ["--open"],
    });
    expect(parseDesktopApplication("[Desktop Entry]\nType=Link\nName=Website\nURL=https://example.com", "/tmp/site.desktop")).toBeNull();
    expect(parseDesktopApplication("[Desktop Entry]\nType=Application\nName=Hidden\nExec=hidden\nHidden=true", "/tmp/hidden.desktop")).toBeNull();
  });

  it("normalizes common keyboard shortcuts for the mouse-free backend", () => {
    expect(normalizeHotkeyForSendKeys("Ctrl+S")).toBe("^S");
    expect(normalizeHotkeyForSendKeys(["Ctrl", "Shift", "P"])).toBe("^+P");
    expect(normalizeHotkeyForSendKeys("Alt+F4")).toBe("%{F4}");
    expect(normalizeHotkeyForSendKeys("Enter")).toBe("{ENTER}");
  });

  it("reports X11 coordinate limitations without declaring Wayland semantic access unsupported", () => {
    expect(linuxX11UnavailableReason({})).toMatch(/No Linux desktop display/);
    expect(linuxX11UnavailableReason({ WAYLAND_DISPLAY: "wayland-0" })).toMatch(
      /AT-SPI accessibility bus is available/,
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
      expect(result.data?.backend).toBe("linux-x11-with-atspi-optional");
      expect(result.data?.actions?.screenshot).toBe(false);
      expect(result.data?.actions?.clickAt).toBe(false);
      expect(result.data?.limitations?.join(" ")).toMatch(/No graphical session is available/);
    } finally {
      if (previousDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = previousDisplay;
      if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = previousWayland;
    }
  });

  it("aborts a hung Linux desktop observation and terminates its subprocess", async () => {
    if (process.platform !== "linux") return;
    const directory = mkdtempSync(path.join(os.tmpdir(), "miki-observer-abort-"));
    const binary = path.join(directory, "xdotool");
    writeFileSync(binary, `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`, { mode: 0o755 });
    chmodSync(binary, 0o755);
    const previousPath = process.env.PATH;
    const previousDisplay = process.env.DISPLAY;
    const previousWayland = process.env.WAYLAND_DISPLAY;
    process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
    process.env.DISPLAY = ":88";
    delete process.env.WAYLAND_DISPLAY;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("test observation deadline")), 100);
    const startedAt = Date.now();
    try {
      await expect(new ComputerAgent(30_000).observe({ active_only: true }, controller.signal)).rejects.toThrow();
      expect(controller.signal.aborted).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      clearTimeout(timer);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = previousDisplay;
      if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = previousWayland;
      rmSync(directory, { recursive: true, force: true });
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
