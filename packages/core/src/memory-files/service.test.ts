import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileMemoryService } from "./service.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-memsvc-"));
}

describe("FileMemoryService (integration)", () => {
  let identityDir: string;
  let service: FileMemoryService;

  beforeEach(() => {
    identityDir = tmpDir();
    service = new FileMemoryService({ identityDir });
  });

  afterEach(() => {
    service.shutdown();
    fs.rmSync(identityDir, { recursive: true, force: true });
  });

  it("note() writes immediately and is awaited by the caller", async () => {
    const r = await service.note("Always deploy on Fridays", "long_term");
    expect(r.path).toBe("MEMORY.md");
    const content = fs.readFileSync(path.join(identityDir, "MEMORY.md"), "utf-8");
    expect(content).toContain("Always deploy on Fridays");
  });

  it("search() finds a note written via note()", async () => {
    await service.note("Owns a red bicycle used for commuting");
    const hits = await service.search("red bicycle");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("buildContextBlock reflects notes without throwing when memory is empty", async () => {
    expect(await service.buildContextBlock()).toBe("");
    await service.note("Some durable fact");
    expect(await service.buildContextBlock()).toContain("Some durable fact");
  });

  it("background() never throws even when the job itself throws", () => {
    expect(() =>
      service.background("risky", () => {
        throw new Error("nope");
      }),
    ).not.toThrow();
  });

  it("onSessionEnd is idempotent for an unchanged conversation", () => {
    const messages = [
      { role: "user" as const, content: "Please remember I like tea." },
      { role: "assistant" as const, content: "Noted, you like tea." },
    ];
    const first = service.onSessionEnd("sess-1", messages, "idle");
    const second = service.onSessionEnd("sess-1", messages, "idle");
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("does too few turns to bother saving a session summary", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(service.onSessionEnd("sess-2", messages, "idle")).toBe(false);
  });

  it("status() reports enabled state and writer stats without throwing", () => {
    const status = service.status();
    expect(status.enabled).toBe(true);
    expect(status.writer).toBeDefined();
  });

  it("shutdown() persists a pending daily note synchronously", () => {
    service.noteDaily("shutdown note", "agent");
    service.shutdown();
    const dailyDir = path.join(identityDir, "memory");
    const files = fs.readdirSync(dailyDir).filter((f) => f.endsWith(".md"));
    const text = files.map((f) => fs.readFileSync(path.join(dailyDir, f), "utf-8")).join("\n");
    expect(text).toContain("shutdown note");
  });
});
