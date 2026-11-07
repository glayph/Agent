import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChatSendFileTool, MAX_FILES_PER_SEND, type ChatMediaDelivery } from "./chat-send-file-tool.js";

describe("chat_send_file tool", () => {
  let workspace: string;
  let dataRoot: string;
  let delivered: ChatMediaDelivery[];
  const context = (runId = "run-1") => ({ runId, sessionId: "session-1", callId: "call-1", signal: new AbortController().signal });
  const makeTool = (allowOutside = false) =>
    createChatSendFileTool({
      getContext: () => ({ workspaceRoot: workspace, dataRoot }),
      getBaseDir: () => workspace,
      allowOutsideWorkspace: () => allowOutside,
      deliver: (delivery) => { delivered.push(delivery); },
    });

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "miki-send-"));
    workspace = path.join(base, "workspace");
    dataRoot = path.join(base, "data");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(dataRoot, "screenshots"), { recursive: true });
    delivered = [];
  });

  it("delivers one file with the model's caption as a single message", async () => {
    fs.writeFileSync(path.join(workspace, "voice.mp3"), "audio");
    const result = await makeTool().execute({ path: "voice.mp3", caption: "  এই নিন  " }, context()) as { delivered: boolean; files: Array<{ type: string }> };
    expect(result.delivered).toBe(true);
    expect(result.files[0].type).toBe("audio");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ runId: "run-1", sessionId: "session-1", caption: "এই নিন" });
    expect(delivered[0].attachments[0]).toMatchObject({ type: "audio", filename: "voice.mp3" });
  });

  it("sends several files together and de-duplicates repeated paths", async () => {
    fs.writeFileSync(path.join(workspace, "a.png"), "a");
    fs.writeFileSync(path.join(workspace, "b.pdf"), "b");
    await makeTool().execute({ path: "a.png", paths: ["a.png", "b.pdf"] }, context());
    expect(delivered).toHaveLength(1);
    expect(delivered[0].attachments.map((item) => item.filename)).toEqual(["a.png", "b.pdf"]);
    expect(delivered[0].caption).toBe("");
  });

  it("is all-or-nothing: one bad path delivers nothing", async () => {
    fs.writeFileSync(path.join(workspace, "ok.png"), "ok");
    await expect(makeTool().execute({ paths: ["ok.png", "missing.png"] }, context())).rejects.toThrow(/not found/i);
    expect(delivered).toHaveLength(0);
  });

  it("validates its arguments", async () => {
    await expect(makeTool().execute({}, context())).rejects.toThrow(/path/);
    const many = Array.from({ length: MAX_FILES_PER_SEND + 1 }, (_, i) => `f${i}.txt`);
    await expect(makeTool().execute({ paths: many }, context())).rejects.toThrow(/At most/);
    await expect(makeTool().execute({ paths: [1] }, context())).rejects.toThrow(/list of file path strings/);
  });

  it("reaches outside the workspace only when allowed", async () => {
    const outside = path.join(path.dirname(workspace), "elsewhere");
    fs.mkdirSync(outside);
    const file = path.join(outside, "render.mp4");
    fs.writeFileSync(file, "video");
    await expect(makeTool(false).execute({ path: file }, context())).rejects.toThrow(/outside the workspace/);
    await makeTool(true).execute({ path: file }, context());
    expect(delivered[0].attachments[0]).toMatchObject({ type: "video", filename: "render.mp4" });
  });

  it("surfaces delivery failures to the model instead of pretending success", async () => {
    fs.writeFileSync(path.join(workspace, "a.png"), "a");
    const tool = createChatSendFileTool({
      getContext: () => ({ workspaceRoot: workspace, dataRoot }),
      allowOutsideWorkspace: () => false,
      deliver: () => { throw new Error("chat is unavailable"); },
    });
    await expect(tool.execute({ path: "a.png" }, context())).rejects.toThrow("chat is unavailable");
  });

  it("is a read-risk, auto-approved tool named chat_send_file", () => {
    const tool = makeTool();
    expect(tool).toMatchObject({ name: "chat_send_file", risk: "read", approval: "auto" });
  });
});
