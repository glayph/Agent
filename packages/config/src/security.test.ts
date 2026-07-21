import {
  allowedCorsOriginsFromEnv,
  getRequiredEnvSecret,
  isAllowedCorsOrigin,
  resolveLiteLLMMasterKey,
} from "./security.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("security helpers", () => {
  const previousMasterKey = process.env["LITELLM_MASTER_KEY"];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-key-"));

  afterEach(() => {
    if (previousMasterKey === undefined) {
      delete process.env["LITELLM_MASTER_KEY"];
    } else {
      process.env["LITELLM_MASTER_KEY"] = previousMasterKey;
    }
  });

  it("allows only configured CORS origins", () => {
    const allowed = allowedCorsOriginsFromEnv({
      Hiro_ALLOWED_ORIGINS: "http://localhost:18800,http://127.0.0.1:18800",
    });

    expect(isAllowedCorsOrigin("http://localhost:18800", allowed)).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:18800", allowed)).toBe(true);
    expect(isAllowedCorsOrigin("http://localhost:5173", allowed)).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:5173", allowed)).toBe(true);
    expect(isAllowedCorsOrigin("http://[::1]:5173", allowed)).toBe(true);
    expect(isAllowedCorsOrigin("http://example.com:18800", allowed)).toBe(
      false,
    );
  });

  it("allows all valid browser origins when explicitly configured with wildcard", () => {
    const allowed = allowedCorsOriginsFromEnv({
      Hiro_ALLOWED_ORIGINS: "*",
    });

    expect(isAllowedCorsOrigin("http://example.com:18800", allowed)).toBe(true);
    expect(isAllowedCorsOrigin("https://app.example.com", allowed)).toBe(true);
    expect(isAllowedCorsOrigin("file://local-page", allowed)).toBe(false);
    expect(isAllowedCorsOrigin("not-a-url", allowed)).toBe(false);
  });

  it("allows all valid browser origins when restrictions are bypassed in workspace config", () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Hiro-cors-"),
    );
    fs.mkdirSync(path.join(workspaceDir, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "config", "agent.yaml"),
      ["agent:", "  security:", "    bypass_restrictions: true", ""].join("\n"),
      "utf-8",
    );

    try {
      const allowed = allowedCorsOriginsFromEnv({ workspaceDir, env: {} });
      expect(isAllowedCorsOrigin("https://external.example", allowed)).toBe(
        true,
      );
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects missing and weak required secrets", () => {
    delete process.env["LITELLM_MASTER_KEY"];
    expect(() =>
      getRequiredEnvSecret("LITELLM_MASTER_KEY", {
        weakValues: ["sk-anything"],
      }),
    ).toThrow(/must be set/);

    process.env["LITELLM_MASTER_KEY"] = "sk-anything";
    expect(() =>
      getRequiredEnvSecret("LITELLM_MASTER_KEY", {
        weakValues: ["sk-anything"],
      }),
    ).toThrow(/unsafe default/);
  });

  it("generates and persists a LiteLLM master key when missing", () => {
    delete process.env["LITELLM_MASTER_KEY"];
    const keyPath = path.join(tempDir, "data", "litellm.master-key");
    const key = resolveLiteLLMMasterKey({
      workspaceDir: tempDir,
      filePath: keyPath,
    });

    expect(key).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(fs.readFileSync(keyPath, "utf-8").trim()).toBe(key);
    expect(process.env["LITELLM_MASTER_KEY"]).toBe(key);
  });
});
