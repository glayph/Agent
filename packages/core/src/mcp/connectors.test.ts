import { namespaceExternalMcpToolName } from "./connectors.js";

describe("External MCP connectors", () => {
  test("namespaces external tool names safely", () => {
    expect(
      namespaceExternalMcpToolName("github server", "pull/request.list"),
    ).toBe("github_server__pull_request_list");
  });
});
