import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_ATTACHMENTS_PER_RUN,
  MEDIA_ROUTE,
  OUTBOX_DIR,
  sentPathsFromToolCall,
  stageChatFile,
  candidatePathsFromToolCall,
  createAttachmentCollector,
  describeFile,
  imageDataUrlFromMediaUrl,
  resolveMediaPath,
  workspaceRelativePathFromMediaUrl,
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


  it("supports common document and video attachment types", () => {
    expect(describeFile("report.docx")).toEqual({
      type: "file",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(describeFile("clip.mov")).toEqual({ type: "video", contentType: "video/quicktime" });
    expect(describeFile("clip.m4v")).toEqual({ type: "video", contentType: "video/mp4" });
    expect(describeFile("recording.opus")).toEqual({ type: "audio", contentType: "audio/opus" });
    expect(describeFile("photo.tiff")).toEqual({ type: "image", contentType: "image/tiff" });
    expect(describeFile("favicon.ico")).toEqual({ type: "image", contentType: "image/x-icon" });
    expect(describeFile("notes.md")).toEqual({ type: "file", contentType: "text/markdown" });
    expect(describeFile("installer.exe")).toBeNull();
  });

  it("resolves uploaded media URLs only to files inside the workspace", () => {
    const uploadDir = path.join(workspace, ".miki-chat-uploads");
    fs.mkdirSync(uploadDir, { recursive: true });
    const image = path.join(uploadDir, "test-image.png");
    fs.writeFileSync(image, Buffer.from("png-test"));
    const url = `${MEDIA_ROUTE}?path=${encodeURIComponent(image)}`;
    expect(workspaceRelativePathFromMediaUrl(url, ctx())).toBe(".miki-chat-uploads/test-image.png");
    expect(imageDataUrlFromMediaUrl(url, ctx())).toBe(`data:image/png;base64,${Buffer.from("png-test").toString("base64")}`);
    const svg = path.join(uploadDir, "vector.svg");
    fs.writeFileSync(svg, "<svg></svg>");
    const svgUrl = `${MEDIA_ROUTE}?path=${encodeURIComponent(svg)}`;
    expect(imageDataUrlFromMediaUrl(svgUrl, ctx())).toBeNull();
    expect(workspaceRelativePathFromMediaUrl(svgUrl, ctx())).toBe(".miki-chat-uploads/vector.svg");
    expect(workspaceRelativePathFromMediaUrl(`${MEDIA_ROUTE}?path=${encodeURIComponent(outside + "/photo.png")}`, ctx())).toBeNull();
  });

  it("refuses missing files and directories", () => {
    fs.mkdirSync(path.join(workspace, "dir.png"));
    expect(resolveMediaPath("nope.png", ctx())).toBeNull();
    expect(resolveMediaPath("dir.png", ctx())).toBeNull();
  });

  describe("explicit delivery (chat_send_file)", () => {
    it("references a known file inside the workspace in place", async () => {
      fs.writeFileSync(path.join(workspace, "clip.mp4"), "video-bytes");
      const staged = await stageChatFile("clip.mp4", ctx());
      expect(staged.copied).toBe(false);
      expect(staged.attachment).toMatchObject({ type: "video", filename: "clip.mp4", content_type: "video/mp4" });
      expect(decodeURIComponent(staged.attachment.url.split("path=")[1])).toBe(fs.realpathSync(path.join(workspace, "clip.mp4")));
    });

    it("copies files from outside the workspace into the outbox once and serves the copy", async () => {
      const source = path.join(outside, "report.pdf");
      fs.writeFileSync(source, "pdf-bytes");
      const first = await stageChatFile(source, ctx(), { allowOutsideWorkspace: true });
      const second = await stageChatFile(source, ctx(), { allowOutsideWorkspace: true });
      expect(first.copied).toBe(true);
      expect(first.attachment).toMatchObject({ type: "file", filename: "report.pdf", content_type: "application/pdf" });
      expect(second.attachment.url).toBe(first.attachment.url);
      const served = resolveMediaPath(decodeURIComponent(first.attachment.url.split("path=")[1]), ctx());
      expect(served).not.toBeNull();
      expect(served!.includes(OUTBOX_DIR)).toBe(true);
      expect(fs.readFileSync(served!, "utf8")).toBe("pdf-bytes");
      expect(fs.readdirSync(path.join(workspace, OUTBOX_DIR))).toHaveLength(1);
    });

    it("serves unknown file types only from the outbox, as generic downloads", async () => {
      const source = path.join(outside, "app.apk");
      fs.writeFileSync(source, "apk");
      const staged = await stageChatFile(source, ctx(), { allowOutsideWorkspace: true });
      expect(staged.attachment).toMatchObject({ type: "file", filename: "app.apk", content_type: "application/octet-stream" });
      expect(resolveMediaPath(decodeURIComponent(staged.attachment.url.split("path=")[1]), ctx())).not.toBeNull();
      // The same type directly in the workspace stays refused by the media route.
      fs.writeFileSync(path.join(workspace, "direct.apk"), "apk");
      expect(resolveMediaPath("direct.apk", ctx())).toBeNull();
    });

    it("keeps non-ASCII file names", async () => {
      fs.writeFileSync(path.join(workspace, "রিপোর্ট.pdf"), "pdf");
      const staged = await stageChatFile("রিপোর্ট.pdf", ctx());
      expect(staged.attachment.filename).toBe("রিপোর্ট.pdf");
    });

    it("refuses outside files when the workspace is enforced, but allows the agent's own working folder", async () => {
      const source = path.join(outside, "photo.png");
      fs.writeFileSync(source, "png");
      await expect(stageChatFile(source, ctx(), {})).rejects.toThrow(/outside the workspace/);
      const staged = await stageChatFile("photo.png", ctx(), { baseDir: outside, extraAllowedRoots: [outside] });
      expect(staged.copied).toBe(true);
      expect(staged.attachment.type).toBe("image");
    });

    it("never sends secrets, databases, directories, empty or missing files", async () => {
      fs.writeFileSync(path.join(workspace, ".env"), "KEY=1");
      fs.writeFileSync(path.join(outside, "id_rsa"), "key");
      fs.writeFileSync(path.join(workspace, "empty.png"), "");
      fs.mkdirSync(path.join(workspace, "folder"));
      await expect(stageChatFile(".env", ctx())).rejects.toThrow(/never sent/);
      await expect(stageChatFile(path.join(outside, "id_rsa"), ctx(), { allowOutsideWorkspace: true })).rejects.toThrow(/never sent/);
      await expect(stageChatFile("empty.png", ctx())).rejects.toThrow(/empty/);
      await expect(stageChatFile("folder", ctx())).rejects.toThrow(/directory/);
      await expect(stageChatFile("missing.png", ctx())).rejects.toThrow(/not found/i);
      await expect(stageChatFile("", ctx())).rejects.toThrow(/required/);
    });

    it("does not follow a symlink to a secret", async () => {
      fs.writeFileSync(path.join(outside, "token.key"), "secret");
      fs.symlinkSync(path.join(outside, "token.key"), path.join(workspace, "innocent.png"));
      await expect(stageChatFile("innocent.png", ctx(), { allowOutsideWorkspace: true })).rejects.toThrow(/never sent/);
    });

    it("reads delivered paths from a succeeded call and the collector skips them", () => {
      expect(sentPathsFromToolCall({ name: "chat_send_file", status: "succeeded", arguments: JSON.stringify({ path: "a.png", paths: ["b.png"] }) })).toEqual(["a.png", "b.png"]);
      expect(sentPathsFromToolCall({ name: "chat_send_file", status: "failed", arguments: '{"path":"a.png"}' })).toEqual([]);
      fs.writeFileSync(path.join(workspace, "chart.svg"), "<svg></svg>");
      const collector = createAttachmentCollector(ctx);
      collector.observe({ name: "file_write", status: "succeeded", arguments: JSON.stringify({ path: "chart.svg" }) });
      expect(collector.list()).toHaveLength(1);
      collector.observe({ name: "chat_send_file", status: "succeeded", arguments: JSON.stringify({ path: "chart.svg" }) });
      expect(collector.list()).toHaveLength(0);
      collector.observe({ name: "file_write", status: "succeeded", arguments: JSON.stringify({ path: "chart.svg" }) });
      expect(collector.list()).toHaveLength(0);
    });

    it("does not auto-attach source or config files written during a task", () => {
      expect(candidatePathsFromToolCall({ name: "file_write", status: "succeeded", arguments: '{"path":"src/app.py"}' })).toEqual([]);
      expect(candidatePathsFromToolCall({ name: "file_write", status: "succeeded", arguments: '{"path":"config.json"}' })).toEqual([]);
      expect(candidatePathsFromToolCall({ name: "file_write", status: "succeeded", arguments: '{"path":"notes.md"}' })).toEqual(["notes.md"]);
      expect(describeFile("x.unknownext")).toBeNull();
      expect(describeFile("x.unknownext", { fallback: true })).toEqual({ type: "file", contentType: "application/octet-stream" });
    });
  });
});
