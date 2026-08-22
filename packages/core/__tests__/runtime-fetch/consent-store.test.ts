import Database from "better-sqlite3";
import { RuntimeInstallConsentStore } from "../../src/runtime-fetch/consent-store.js";

describe("RuntimeInstallConsentStore", () => {
  it("creates a pending request and finds it by fingerprint regardless of package order", () => {
    const db = new Database(":memory:");
    const store = new RuntimeInstallConsentStore(db);

    const created = store.createPending(
      "software-development/python-debugpy",
      "python",
      ["debugpy", "remote-pdb"],
      undefined,
      "needs debugpy",
    );
    expect(created.status).toBe("pending");

    const found = store.findByFingerprint(
      "software-development/python-debugpy",
      "python",
      ["remote-pdb", "debugpy"], // reordered
    );
    expect(found?.id).toBe(created.id);
  });

  it("does not confuse different package sets for the same skill+language", () => {
    const db = new Database(":memory:");
    const store = new RuntimeInstallConsentStore(db);

    store.createPending("skill-a", "python", ["numpy"]);
    const other = store.findByFingerprint("skill-a", "python", ["scipy"]);
    expect(other).toBeUndefined();
  });

  it("moves a request through the full approve -> installing -> ready lifecycle", () => {
    const db = new Database(":memory:");
    const store = new RuntimeInstallConsentStore(db);

    const req = store.createPending("skill-a", "python", ["debugpy"]);
    store.decide(req.id, "approved", "user-cli");
    let updated = store.getById(req.id)!;
    expect(updated.status).toBe("approved");
    expect(updated.decidedBy).toBe("user-cli");

    store.markInstalling(req.id);
    expect(store.getById(req.id)!.status).toBe("installing");

    store.markReady(req.id, "/sandbox/skill-a/python");
    updated = store.getById(req.id)!;
    expect(updated.status).toBe("ready");
    expect(updated.sandboxPath).toBe("/sandbox/skill-a/python");
  });

  it("records failure with manual fallback instructions", () => {
    const db = new Database(":memory:");
    const store = new RuntimeInstallConsentStore(db);

    const req = store.createPending("skill-a", "ruby", ["nokogiri"]);
    store.markFailed(
      req.id,
      "network unreachable",
      "run `gem install nokogiri` yourself",
    );
    const updated = store.getById(req.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.error).toBe("network unreachable");
    expect(updated.manualInstructions).toContain("gem install");
  });

  it("lists only pending requests, oldest first", () => {
    const db = new Database(":memory:");
    const store = new RuntimeInstallConsentStore(db);

    const first = store.createPending("skill-a", "python", ["a"]);
    const second = store.createPending("skill-b", "ruby", ["b"]);
    store.decide(second.id, "approved");

    const pending = store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(first.id);
  });
});
