import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "@jest/globals";
import { loadMcpRuntimeConfig } from "./config.js";
import type { RuntimePaths } from "../paths.js";

function makePaths(root: string): RuntimePaths {
  return {
    configDir: path.join(root, "config"),
    dataDir: path.join(root, "data"),
    skillsDir: path.join(root, "skills"),
    cacheDir: path.join(root, "cache"),
    binDir: path.join(root, "bin"),
    docsDir: path.join(root, "docs"),
    outputDir: path.join(root, "output"),
    sourceDir: root,
  };
}

describe("MCP runtime config", () => {
  test("parses environment-backed auth and explicit side-effect opt-in", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-mcp-config-"));
    try {
      const paths = makePaths(root);
      fs.mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(paths.configDir, "tools.yaml"),
        [
          "runtime:",
          "  mcp:",
          "    enabled: true",
          "    servers:",
          "      trusted:",
          "        type: http",
          "        url: https://mcp.example.test/mcp",
          "        header_env:",
          "          Authorization: MIKI_MCP_AUTH",
          "        allow_side_effects: true",
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
      const config = loadMcpRuntimeConfig(paths);
      expect(config.servers.trusted).toMatchObject({
        type: "http",
        url: "https://mcp.example.test/mcp",
        headerEnv: { Authorization: "MIKI_MCP_AUTH" },
        allowSideEffects: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults side effects to disabled when omitted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-mcp-config-"));
    try {
      const paths = makePaths(root);
      fs.mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(paths.configDir, "tools.yaml"),
        [
          "runtime:",
          "  mcp:",
          "    servers:",
          "      public:",
          "        type: sse",
          "        url: https://mcp.example.test/events",
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
      const config = loadMcpRuntimeConfig(paths);
      expect(config.servers.public.allowSideEffects).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
