import * as path from "path";
import { pathToFileURL } from "url";
import {
  resolveLiteLLMCommand,
  rewriteApiProxyPath,
  rewriteMcpProxyPath,
  rewriteWebhookProxyPath,
  runtimeLoaderArgsFor,
} from "./runtime-utils.js";

describe("gateway runtime utilities", () => {
  test("runtimeLoaderArgsFor emits a Node register import path", () => {
    const loaderPath = path.resolve("runtime-loader.mjs");

    const args = runtimeLoaderArgsFor(loaderPath, () => true);
    expect(args).toHaveLength(2);
    expect(args[0]).toBe("--import");
    expect(args[1]).toContain("data:text/javascript,");
    expect(decodeURIComponent(args[1])).toContain(
      `register("${pathToFileURL(loaderPath).href}", pathToFileURL("./"))`,
    );
  });

  test("runtimeLoaderArgsFor omits a missing loader", () => {
    expect(runtimeLoaderArgsFor("missing-loader.mjs", () => false)).toEqual([]);
  });

  test("rewrites API, webhook, and MCP proxy paths to core routes", () => {
    expect(rewriteApiProxyPath("/pico/info")).toBe("/api/pico/info");
    expect(rewriteWebhookProxyPath("/whatsapp")).toBe("/webhooks/whatsapp");
    expect(rewriteWebhookProxyPath("/")).toBe("/webhooks");
    expect(rewriteMcpProxyPath("/")).toBe("/mcp");
    expect(rewriteMcpProxyPath("/tools/list")).toBe("/mcp/tools/list");
  });

  test("resolves a Windows LiteLLM executable without shell", () => {
    const appData = "C:\\Users\\Agent\\AppData\\Roaming";
    const expected = path.win32.join(
      appData,
      "Python",
      "Python313",
      "Scripts",
      "litellm.exe",
    );

    expect(
      resolveLiteLLMCommand({
        platform: "win32",
        env: { APPDATA: appData, PATH: "" },
        fileExists: (candidate) => candidate === expected,
      }),
    ).toEqual({ command: expected, shell: false });
  });

  test("resolves a PATH LiteLLM executable without shell", () => {
    const scriptsDir = "C:\\Tools\\Python\\Scripts";
    const expected = path.win32.join(scriptsDir, "litellm.exe");

    expect(
      resolveLiteLLMCommand({
        platform: "win32",
        env: { PATH: scriptsDir },
        fileExists: (candidate) => candidate === expected,
      }),
    ).toEqual({ command: expected, shell: false });
  });

  test("uses shell only when Windows resolution lands on a command script", () => {
    const scriptsDir = "C:\\Tools\\Python\\Scripts";
    const expected = path.win32.join(scriptsDir, "litellm.cmd");

    expect(
      resolveLiteLLMCommand({
        platform: "win32",
        env: { PATH: scriptsDir },
        fileExists: (candidate) => candidate === expected,
      }),
    ).toEqual({ command: expected, shell: true });
  });

  test("falls back to shell on unresolved Windows PATH command", () => {
    expect(
      resolveLiteLLMCommand({
        platform: "win32",
        env: { PATH: "" },
        fileExists: () => false,
      }),
    ).toEqual({ command: "litellm", shell: true });
  });

  test("resolves a POSIX LiteLLM executable without shell", () => {
    const binDir = "/opt/Hiro/bin";
    const expected = path.posix.join(binDir, "litellm");

    expect(
      resolveLiteLLMCommand({
        platform: "linux",
        env: { PATH: binDir },
        fileExists: (candidate) => candidate === expected,
      }),
    ).toEqual({ command: expected, shell: false });
  });
});
