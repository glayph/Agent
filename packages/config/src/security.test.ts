import {
  allowedCorsOriginsFromEnv,
  getRequiredEnvSecret,
  isAllowedCorsOrigin,
  isIpAllowedByCidrs,
  isValidCidr,
  isLoopbackAddress,
} from "./security.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("security helpers", () => {
  const previousTestSecret = process.env["TEST_REQUIRED_SECRET"];

  afterEach(() => {
    if (previousTestSecret === undefined) {
      delete process.env["TEST_REQUIRED_SECRET"];
    } else {
      process.env["TEST_REQUIRED_SECRET"] = previousTestSecret;
    }
  });

  it("uses process.env safely when no CORS options are supplied", () => {
    expect(() => allowedCorsOriginsFromEnv()).not.toThrow();
    expect(() => isAllowedCorsOrigin("http://localhost:5173")).not.toThrow();
  });

  it("allows only configured CORS origins", () => {
    const allowed = allowedCorsOriginsFromEnv({
      Miki_ALLOWED_ORIGINS: "http://localhost:18800,http://127.0.0.1:18800",
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

  it("rejects loopback origins outside the allowlist when origins are explicitly configured (#11)", () => {
    // Real callers (packages/core/src/api/index.ts, packages/gateway/src/index.ts)
    // always pass hasExplicitAllowedOrigins() as the 3rd argument. The
    // loopback bypass exercised in the previous test only applies when
    // that 3rd argument is left at its default (false) - i.e. no
    // MIKI_ALLOWED_ORIGINS was set at all. Once a user narrows the
    // allowlist explicitly, every other loopback port (a second dev
    // server, another app, anything else running locally) must be
    // rejected just like a non-loopback origin would be - otherwise a
    // narrowed MIKI_ALLOWED_ORIGINS value provides no real protection
    // against credentialed cross-origin requests from other local ports.
    const allowed = allowedCorsOriginsFromEnv({
      MIKI_ALLOWED_ORIGINS: "http://localhost:18800",
    } as NodeJS.ProcessEnv);
    const explicit = true;

    expect(
      isAllowedCorsOrigin("http://localhost:18800", allowed, explicit),
    ).toBe(true);
    expect(
      isAllowedCorsOrigin("http://127.0.0.1:18800", allowed, explicit),
    ).toBe(false);
    expect(
      isAllowedCorsOrigin("http://localhost:5173", allowed, explicit),
    ).toBe(false);
    expect(isAllowedCorsOrigin("http://[::1]:9999", allowed, explicit)).toBe(
      false,
    );
  });

  it("also honors the canonical uppercase MIKI_ALLOWED_ORIGINS name (#env-casing)", () => {
    const allowed = allowedCorsOriginsFromEnv({
      MIKI_ALLOWED_ORIGINS: "http://localhost:18800",
    } as NodeJS.ProcessEnv);

    expect(isAllowedCorsOrigin("http://localhost:18800", allowed)).toBe(true);
    expect(isAllowedCorsOrigin("http://example.com:18800", allowed)).toBe(
      false,
    );
  });

  it("prefers MIKI_ALLOWED_ORIGINS over the legacy Miki_ALLOWED_ORIGINS when both are set", () => {
    const allowed = allowedCorsOriginsFromEnv({
      MIKI_ALLOWED_ORIGINS: "http://new.example.com",
      Miki_ALLOWED_ORIGINS: "http://old.example.com",
    } as NodeJS.ProcessEnv);

    expect(isAllowedCorsOrigin("http://new.example.com", allowed)).toBe(true);
    expect(isAllowedCorsOrigin("http://old.example.com", allowed)).toBe(false);
  });

  it("allows all valid browser origins when explicitly configured with wildcard", () => {
    const allowed = allowedCorsOriginsFromEnv({
      Miki_ALLOWED_ORIGINS: "*",
    });

    expect(isAllowedCorsOrigin("http://example.com:18800", allowed)).toBe(true);
    expect(isAllowedCorsOrigin("https://app.example.com", allowed)).toBe(true);
    expect(isAllowedCorsOrigin("file://local-page", allowed)).toBe(false);
    expect(isAllowedCorsOrigin("not-a-url", allowed)).toBe(false);
  });

  it("allows all valid browser origins when restrictions are bypassed in workspace config", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-cors-"));
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
    delete process.env["TEST_REQUIRED_SECRET"];
    expect(() =>
      getRequiredEnvSecret("TEST_REQUIRED_SECRET", {
        weakValues: ["sk-anything"],
      }),
    ).toThrow(/must be set/);

    process.env["TEST_REQUIRED_SECRET"] = "sk-anything";
    expect(() =>
      getRequiredEnvSecret("TEST_REQUIRED_SECRET", {
        weakValues: ["sk-anything"],
      }),
    ).toThrow(/unsafe default/);
  });

  it("matches configured IPv4 and IPv6 CIDRs without a loopback bypass", () => {
    expect(isIpAllowedByCidrs("10.20.30.40", ["10.20.0.0/16"])).toBe(true);
    expect(isIpAllowedByCidrs("10.21.30.40", ["10.20.0.0/16"])).toBe(false);
    expect(isIpAllowedByCidrs("127.0.0.1", ["127.0.0.1/32"])).toBe(true);
    expect(isIpAllowedByCidrs("127.0.0.1", ["10.0.0.0/8"])).toBe(false);
    expect(isIpAllowedByCidrs("2001:db8::42", ["2001:db8::/64"])).toBe(true);
    expect(isIpAllowedByCidrs("2001:db9::42", ["2001:db8::/64"])).toBe(false);
  });

  it("validates allowed CIDR values", () => {
    expect(isValidCidr("10.0.0.0/8")).toBe(true);
    expect(isValidCidr("2001:db8::/32")).toBe(true);
    expect(isValidCidr("*")).toBe(true);
    expect(isValidCidr("10.0.0.0/33")).toBe(false);
    expect(isValidCidr("not-a-network")).toBe(false);
  });

  it("identifies loopback addresses in their various forms (#94)", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.5.5.5")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("203.0.113.7")).toBe(false);
    expect(isLoopbackAddress("::ffff:203.0.113.7")).toBe(false);
    expect(isLoopbackAddress("2001:db8::1")).toBe(false);
  });
});
