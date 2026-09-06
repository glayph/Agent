import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createProcessStateStore,
  ProcessStateStore,
} from "../src/process-state-snapshot.js";

describe("ProcessStateStore", () => {
  let tmpDir: string;
  let statePath: string;
  let store: ProcessStateStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-process-state-"));
    statePath = path.join(tmpDir, "data", "process-state.json");
    store = new ProcessStateStore(statePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty baseline snapshot when no file exists yet", () => {
    const snapshot = store.read();
    expect(snapshot.lastHealthyAt).toBeNull();
    expect(snapshot.restartAttempts).toBe(0);
    expect(snapshot.cleanShutdown).toBe(false);
  });

  it("treats a corrupt snapshot file as absent rather than throwing", () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{ not valid json", "utf-8");
    const snapshot = store.read();
    expect(snapshot.restartAttempts).toBe(0);
    expect(snapshot.cleanShutdown).toBe(false);
  });

  it("persists recordHealthy() across a fresh read, clearing cleanShutdown", () => {
    store.recordCleanShutdown();
    expect(store.read().cleanShutdown).toBe(true);

    store.recordHealthy();
    const snapshot = store.read();
    expect(snapshot.cleanShutdown).toBe(false);
    expect(snapshot.lastHealthyAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(snapshot.lastHealthyAt as string))).toBe(
      false,
    );
  });

  it("increments restartAttempts across repeated calls without clobbering", () => {
    store.recordRestartAttempt();
    store.recordRestartAttempt();
    store.recordRestartAttempt();
    expect(store.read().restartAttempts).toBe(3);
  });

  it("marks and reads back a clean shutdown", () => {
    store.recordRestartAttempt();
    store.recordCleanShutdown();
    const snapshot = store.read();
    expect(snapshot.cleanShutdown).toBe(true);
    expect(snapshot.restartAttempts).toBe(1);
  });

  it("resetForColdStart() clears restart bookkeeping but not the file itself", () => {
    store.recordRestartAttempt();
    store.recordRestartAttempt();
    store.resetForColdStart();
    const snapshot = store.read();
    expect(snapshot.restartAttempts).toBe(0);
    expect(snapshot.lastHealthyAt).toBeNull();
    expect(snapshot.cleanShutdown).toBe(false);
  });

  it("writes atomically: no partial file is ever left at the real path", () => {
    // Fire several writes back-to-back; if the implementation weren't
    // atomic (tmp+rename), a reader racing the writes could observe a
    // truncated/partial JSON file. Since these are synchronous here,
    // this mainly guards against a future refactor reintroducing a
    // direct non-atomic writeFileSync to the real path.
    for (let i = 0; i < 10; i++) {
      store.recordRestartAttempt();
    }
    const raw = fs.readFileSync(statePath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const leftoverTmpFiles = fs
      .readdirSync(path.dirname(statePath))
      .filter((name) => name.endsWith(".tmp"));
    expect(leftoverTmpFiles).toEqual([]);
  });

  it("createProcessStateStore() derives the path from workspaceDir/data", () => {
    const derived = createProcessStateStore(tmpDir);
    derived.recordHealthy();
    expect(fs.existsSync(path.join(tmpDir, "data", "process-state.json"))).toBe(
      true,
    );
  });
});
