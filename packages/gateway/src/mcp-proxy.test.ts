import * as fs from "fs";
import * as path from "path";

describe("gateway MCP boundary", () => {
  test("does not host a duplicate MCP server implementation", () => {
    expect(
      fs.existsSync(
        path.join(process.cwd(), "packages", "gateway", "src", "mcp-server.ts"),
      ),
    ).toBe(false);
  });
});
