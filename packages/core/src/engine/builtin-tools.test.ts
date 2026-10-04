import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createControlTools,
  createMemoryTools,
  createWorkspaceTools,
  isSensitivePath,
  resolveWorkspacePath,
} from "./builtin-tools.js";
import type { ToolExecutionContext } from "./types.js";

const ctx = (): ToolExecutionContext => ({
  runId: "r", callId: "c", signal: new AbortController().signal,
});

// Tool execute() may be sync or async; normalise so thrown errors become rejections.
const run = async (tool: { execute: (i: Record<string, unknown>, c: ToolExecutionContext) => unknown }, input: Record<string, unknown>) =>
  tool.execute(input, ctx());

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-ws-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const Alpha = 1;\nconst beta = 2;\n");
  fs.writeFileSync(path.join(root, "node_modules", "dep.js"), "alpha hidden dependency");
  fs.writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=sk-secretsecretsecretsecret");
  fs.writeFileSync(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
  const tools = Object.fromEntries(createWorkspaceTools({ root }).map((t) => [t.name, t]));
  return { root, tools };
}

describe("workspace tools", () => {
  it("lists a directory and flags restricted files", async () => {
    const { tools } = workspace();
    const result = (await tools.workspace_list.execute({}, ctx())) as { entries: Array<{ name: string; restricted?: boolean }> };
    expect(result.entries.map((e) => e.name)).toEqual(expect.arrayContaining(["src", ".env"]));
    expect(result.entries.find((e) => e.name === ".env")?.restricted).toBe(true);
  });

  it("reads text files and reports truncation", async () => {
    const { tools } = workspace();
    const full = (await tools.file_read.execute({ path: "src/a.ts" }, ctx())) as { content: string; truncated: boolean };
    expect(full.content).toContain("Alpha");
    expect(full.truncated).toBe(false);
    const part = (await tools.file_read.execute({ path: "src/a.ts", maxBytes: 5 }, ctx())) as { content: string; truncated: boolean };
    expect(part.content).toHaveLength(5);
    expect(part.truncated).toBe(true);
  });

  it("refuses traversal, absolute escapes, secrets and binary files", async () => {
    const { tools } = workspace();
    await expect(run(tools.file_read, { path: "../outside.txt" })).rejects.toThrow("outside the workspace");
    await expect(run(tools.file_read, { path: "/etc/passwd" })).rejects.toThrow("outside the workspace");
    await expect(run(tools.file_read, { path: ".env" })).rejects.toThrow("blocked");
    await expect(run(tools.file_read, { path: "image.bin" })).rejects.toThrow("binary");
  });

  it("refuses symlinks that point outside the workspace", async () => {
    const { root, tools } = workspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "miki-outside-"));
    fs.writeFileSync(path.join(outside, "x.txt"), "outside");
    fs.symlinkSync(outside, path.join(root, "link"));
    await expect(run(tools.file_read, { path: "link/x.txt" })).rejects.toThrow("symbolic link");
    expect(() => resolveWorkspacePath(root, "link")).toThrow("symbolic link");
  });

  it("searches text, skipping node_modules and secret files", async () => {
    const { tools } = workspace();
    const result = (await tools.workspace_search.execute({ query: "ALPHA" }, ctx())) as { matches: Array<{ file: string; line: number }> };
    expect(result.matches).toEqual([{ file: path.join("src", "a.ts"), line: 1, text: "export const Alpha = 1;" }]);
    const secret = (await tools.workspace_search.execute({ query: "sk-secret" }, ctx())) as { matches: unknown[] };
    expect(secret.matches).toHaveLength(0);
  });

  it("writes files only with approval metadata, never overwrites silently, and blocks secrets", async () => {
    const { root, tools } = workspace();
    expect(tools.file_write.approval).toBe("required");
    expect(tools.file_write.risk).toBe("config_write");
    await tools.file_write.execute({ path: "notes/new.txt", content: "hello" }, ctx());
    expect(fs.readFileSync(path.join(root, "notes", "new.txt"), "utf8")).toBe("hello");
    await expect(run(tools.file_write, { path: "notes/new.txt", content: "x" })).rejects.toThrow("overwrite");
    await tools.file_write.execute({ path: "notes/new.txt", content: "v2", overwrite: true }, ctx());
    expect(fs.readFileSync(path.join(root, "notes", "new.txt"), "utf8")).toBe("v2");
    await expect(run(tools.file_write, { path: ".env", content: "x", overwrite: true })).rejects.toThrow("blocked");
    await expect(run(tools.file_write, { path: "../escape.txt", content: "x" })).rejects.toThrow("outside");
  });

  it("recognises credential file names", () => {
    for (const name of [".env", ".env.local", "data/miki-runtime.sqlite", "secret-vault.json", "id_rsa", "a/b/server.pem", "home/.ssh/config"])
      expect(isSensitivePath(name)).toBe(true);
    for (const name of ["README.md", "src/secret-scan.ts", "environment.ts"])
      expect(isSensitivePath(name)).toBe(false);
  });
});

describe("memory and control tools", () => {
  it("delegates to the memory port and validates input", async () => {
    const memory = {
      search: jest.fn(async () => [{ id: "1", text: "note" }]),
      add: jest.fn(async () => ({ id: "new" })),
    };
    const tools = Object.fromEntries(createMemoryTools(memory).map((t) => [t.name, t]));
    await expect(run(tools.memory_search, { query: "q", limit: 99 })).resolves.toEqual({ count: 1, hits: [{ id: "1", text: "note" }] });
    expect(memory.search).toHaveBeenCalledWith("q", 20);
    await expect(run(tools.memory_add, { content: "  " })).rejects.toThrow("empty");
    await expect(run(tools.memory_add, { content: "fact" })).resolves.toEqual({ id: "new" });
  });

  it("maps control tool definitions and executes with the api origin", async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const tools = createControlTools({
      definitions: [{ name: "agent_control_state", description: "d", risk: "read", parameters: { type: "object" } }],
      execute,
    });
    expect(tools[0].approval).toBe("auto");
    await tools[0].execute({}, { ...ctx(), sessionId: "s1" });
    expect(execute).toHaveBeenCalledWith("agent_control_state", {}, expect.objectContaining({ origin: "api", actor: "agent", sessionId: "s1" }));
  });
});
