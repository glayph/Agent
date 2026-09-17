import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getPlatformDescriptor,
  listPlatformDescriptors,
  SqlitePlatformConnectionStore,
} from "./platform-connections.js";

describe("platform integration readiness", () => {
  it("reports channel runtime status separately from publishing implementation", () => {
    expect(getPlatformDescriptor("telegram")).toEqual(
      expect.objectContaining({
        implementation: "planned",
        channel_runtime_status: "functional",
      }),
    );
    expect(getPlatformDescriptor("discord")).toEqual(
      expect.objectContaining({ channel_runtime_status: "functional" }),
    );
    expect(getPlatformDescriptor("slack")).toEqual(
      expect.objectContaining({ channel_runtime_status: "functional" }),
    );
    expect(getPlatformDescriptor("whatsapp")).toEqual(
      expect.objectContaining({ channel_runtime_status: "partial" }),
    );
  });

  it("keeps Facebook and YouTube publishing explicitly unavailable", () => {
    for (const provider of ["facebook", "youtube"] as const) {
      const descriptor = getPlatformDescriptor(provider);
      expect(descriptor.implementation).toBe("planned");
      expect(descriptor.channel_runtime_status).toBe("unavailable");
      expect(
        descriptor.capabilities.every((capability) => !capability.available),
      ).toBe(true);
      expect(descriptor.channel_runtime_note).toMatch(/blocked|No .* adapter/i);
    }
  });

  it("exposes the runtime/publishing distinction in the descriptor list", () => {
    const descriptors = listPlatformDescriptors();
    const byId = new Map(
      descriptors.map((descriptor) => [descriptor.id, descriptor]),
    );
    expect(byId.get("facebook")?.channel_runtime_status).toBe("unavailable");
    expect(byId.get("youtube")?.channel_runtime_status).toBe("unavailable");
    expect(byId.get("telegram")?.channel_runtime_status).toBe("functional");
    expect(byId.get("whatsapp")?.channel_runtime_status).toBe("partial");
  });

  it("does not turn a planned provider connection into connected", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-platform-test-"),
    );
    const dbPath = path.join(directory, "platform.sqlite");
    try {
      const store = new SqlitePlatformConnectionStore(dbPath);
      const session = store.begin({ provider: "youtube" });
      const { connection } = store.complete(session.id, {
        accountLabel: "test channel",
        credentialRef: "platform/youtube/test-reference",
      });
      expect(connection.status).toBe("needs_validation");
      const validated = store.validate(connection.id);
      expect(validated.status).toBe("needs_validation");
      expect(validated.healthMessage).toMatch(/No production adapter/i);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
