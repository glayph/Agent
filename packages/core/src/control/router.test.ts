import express from "express";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { createControlRouter } from "./router.js";
import { AgentControlService } from "./service.js";

function createService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-control-router-"));
  const controller = {
    getConfig: () => ({ agent: { name: "Miki" }, tools: { tool_state: {} } }),
    validateConfig: () => ({ valid: true }),
    validatePatch: () => ({ valid: true }),
    applyPatch: async () => ({
      runtime_apply_status: "applied",
      gateway_restart_required: false,
    }),
    setToolState: async () => ({
      runtime_apply_status: "applied",
      gateway_restart_required: false,
    }),
  };
  return {
    root,
    service: new AgentControlService({
      controller,
      runtimePaths: { dataDir: path.join(root, "data") } as never,
    }),
  };
}

describe("control router", () => {
  it("returns capabilities and a sanitized state snapshot", async () => {
    const { root, service } = createService();
    const app = express();
    app.use(express.json());
    app.use(
      "/api/control",
      createControlRouter(() => service),
    );
    const server = await new Promise<import("http").Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address() as AddressInfo;
    try {
      const capabilitiesResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/control/capabilities`,
      );
      const capabilities = await capabilitiesResponse.json();
      expect(capabilitiesResponse.status).toBe(200);
      expect(capabilities.capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "system_state" }),
          expect.objectContaining({ id: "config" }),
        ]),
      );

      const stateResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/control/state`,
      );
      const state = await stateResponse.json();
      expect(stateResponse.status).toBe(200);
      expect(state.state.config.agent.name).toBe("Miki");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
