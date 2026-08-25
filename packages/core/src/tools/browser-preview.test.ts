import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserTool, rewriteWorkspacePreviewUrl } from "./browser.js";

describe("workspace browser preview server", () => {
  let blocker: Server | undefined;
  let tool: BrowserTool | undefined;
  let workspaceDir = "";

  afterEach(async () => {
    await tool?.close();
    tool = undefined;
    if (blocker) {
      await new Promise<void>((resolve) => blocker?.close(() => resolve()));
      blocker = undefined;
    }
    if (workspaceDir) fs.rmSync(workspaceDir, { recursive: true, force: true });
    workspaceDir = "";
  });

  it("does not use an occupied 8765 port or serve another workspace", async () => {
    blocker = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("occupied-port-sentinel");
    });
    await new Promise<void>((resolve, reject) => {
      blocker?.once("error", reject);
      blocker?.listen(8765, "127.0.0.1", () => resolve());
    });

    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-preview-"));
    fs.writeFileSync(
      path.join(workspaceDir, "index.html"),
      "<!doctype html><title>current workspace</title>",
      "utf8",
    );
    tool = new BrowserTool(true, workspaceDir);
    tool.setWorkspaceDir(workspaceDir);

    const internalTool = tool as unknown as {
      _ensureWorkspacePreviewServer: () => Promise<void>;
      workspacePreviewPort: number | null;
    };
    await internalTool._ensureWorkspacePreviewServer();

    const ownedPort = internalTool.workspacePreviewPort;
    expect(ownedPort).toBeGreaterThan(0);
    expect(ownedPort).not.toBe(8765);
    expect(
      rewriteWorkspacePreviewUrl(
        "http://localhost:8765/index.html",
        ownedPort!,
      ),
    ).toBe(`http://localhost:${ownedPort}/index.html`);

    const response = await fetch(`http://127.0.0.1:${ownedPort}/index.html`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("current workspace");
  });
});
