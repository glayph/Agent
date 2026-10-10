import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_ATTACHMENTS_PER_RUN,
  MEDIA_ROUTE,
  candidatePathsFromToolCall,
  createAttachmentCollector,
  resolveMediaPath,
} from "./chat-attachments.js";

describe("chat attachments", () => {
  let workspace: string;
  let dataRoot: string;
  let outside: string;
  const ctx = () => ({ workspaceRoot: workspace, dataRoot });

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "miki-attach-"));
    workspace = path.join(base, "workspace");
    dataRoot = path.join(base, "data");
    outside = path.join(base, "outside");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(dataRoot, "screenshots"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
  });

  it("turns a succeeded browser screenshot into an image attachment", () => {
    const shot = path.join(dataRoot, "screenshots", "screenshot_ab12.png");
    fs.writeFileSync(shot, "png");
    const collector = createAttachmentCollector(ctx);
    collector.observe({
      name: "browser_screenshot",
      status: "succeeded",
      resultPreview: `Screenshot saved to: ${shot}`,
    });
    const [attachment] = collector.list();
    expect(attachment.type).toBe("image");
    expect(attachment.content_type).toBe("image/png");
    expect(attachment.filename).toBe("screenshot_ab12.png");
    expect(attachment.url.startsWith(`${MEDIA_ROUTE}?path=`)).toBe(true);
    expect(decodeURIComponent(attachment.url.split("path=")[1])).toBe(fs.realpathSync(shot));
  });

  it("shows files the agent wrote, resolving relative paths in the workspace", () => {
    fs.mkdirSync(path.join(workspace, "repaired-agent-test"));
    fs.writeFileSync(path.join(workspace, "repaired-agent-test", "summary.md"), "# hi");
    const collector = createAttachmentCollector(ctx);
    collector.observe({
      name: "file_write",
      status: "succeeded",
      arguments: JSON.stringify({ path: "repaired-agent-test/summary.md", content: "# hi" }),
    });
    expect(collector.list()).toHaveLength(1);
    expect(collector.list()[0]).toMatchObject({ type: "file", filename: "summary.md", content_type: "text/markdown" });
  });

  it("ignores calls that did not succeed and unrelated tools", () => {
    expect(candidatePathsFromToolCall({ name: "file_write", status: "failed", arguments: '{"path":"a.md"}' })).toEqual([]);
    expect(candidatePathsFromToolCall({ name: "file_read", status: "succeeded", arguments: '{"path":"a.md"}' })).toEqual([]);
  });

  it("deduplicates by path and caps attachments per run", () => {
    const collector = createAttachmentCollector(ctx);
    for (let i = 0; i < MAX_ATTACHMENTS_PER_RUN + 4; i += 1) {
      fs.writeFileSync(path.join(workspace, `f${i}.txt`), "x");
      collector.observe({ name: "file_write", status: "succeeded", arguments: JSON.stringify({ path: `f${i}.txt` }) });
      collector.observe({ name: "file_write", status: "succeeded", arguments: JSON.stringify({ path: `f${i}.txt` }) });
    }
    expect(collector.list()).toHaveLength(MAX_ATTACHMENTS_PER_RUN);
  });

  it("refuses paths outside the workspace and screenshots dir", () => {
    const secret = path.join(outside, "photo.png");
    fs.writeFileSync(secret, "png");
    expect(resolveMediaPath(secret, ctx())).toBeNull();
    expect(resolveMediaPath("../outside/photo.png", ctx())).toBeNull();
  });

  it("refuses symlinks that escape the workspace", () => {
    const target = path.join(outside, "photo.png");
    fs.writeFileSync(target, "png");
    fs.symlinkSync(target, path.join(workspace, "link.png"));
    expect(resolveMediaPath("link.png", ctx())).toBeNull();
  });

  it("refuses secrets, databases, .git contents and unknown types even inside the workspace", () => {
    fs.writeFileSync(path.join(workspace, ".env"), "KEY=1");
    fs.writeFileSync(path.join(workspace, "miki-runtime.sqlite"), "db");
    fs.writeFileSync(path.join(workspace, "tool.exe"), "bin");
    fs.mkdirSync(path.join(workspace, ".git"));
    fs.writeFileSync(path.join(workspace, ".git", "config.txt"), "x");
    for (const name of [".env", "miki-runtime.sqlite", "tool.exe", ".git/config.txt"]) {
      expect(resolveMediaPath(name, ctx())).toBeNull();
    }
  });

  it("refuses missing files and directories", () => {
    fs.mkdirSync(path.join(workspace, "dir.png"));
    expect(resolveMediaPath("nope.png", ctx())).toBeNull();
    expect(resolveMediaPath("dir.png", ctx())).toBeNull();
  });
});
