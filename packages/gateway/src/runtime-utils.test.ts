import {
  rewriteApiProxyPath,
  rewriteMcpProxyPath,
  rewriteWebhookProxyPath,
  runtimeLoaderArgsFor,
} from "./runtime-utils";

describe("runtime-utils", () => {
  test("rewrites API proxy paths", () => {
    expect(rewriteApiProxyPath("/models")).toBe("/api/models");
  });

  test("rewrites webhook proxy paths", () => {
    expect(rewriteWebhookProxyPath("/")).toBe("/webhooks");
    expect(rewriteWebhookProxyPath("/telegram")).toBe("/webhooks/telegram");
  });

  test("rewrites MCP proxy paths", () => {
    expect(rewriteMcpProxyPath("/")).toBe("/mcp");
    expect(rewriteMcpProxyPath("/tools/list")).toBe("/mcp/tools/list");
  });

  test("returns no loader args when loader is missing", () => {
    const args = runtimeLoaderArgsFor("/missing/loader.mjs", () => false);
    expect(args).toEqual([]);
  });

  test("builds --import loader args when loader exists", () => {
    const args = runtimeLoaderArgsFor("/tmp/loader.mjs", () => true);
    expect(args.length).toBe(2);
    expect(args[0]).toBe("--import");
    expect(args[1]).toContain("register");
  });
});
