import { resolveModelRouterConfig } from "./config.js";

describe("resolveModelRouterConfig", () => {
  it("parses lanes, roles and credential profiles (snake_case yaml)", () => {
    const cfg = resolveModelRouterConfig({
      defaultModel: "x/default",
      modelRouter: {
        lanes: {
          default: { primary: "a/m1", fallbacks: ["b/m2", "a/m1", "b/m2"] },
          Heartbeat: "cheap/tiny",
          bad: { fallbacks: ["x/y"] },
        },
        roles: { forge: "heartbeat", sage: { primary: "s/one" }, nope: "missing" },
        credential_profiles: { Gemini: ["GEMINI_API_KEY_2", "not valid!", "GEMINI_API_KEY_2"] },
        max_attempts: 99,
      },
    });
    expect(cfg.origin).toBe("model_router");
    expect(cfg.lanes.default).toEqual({ primary: "a/m1", fallbacks: ["b/m2"] });
    expect(cfg.lanes.heartbeat).toEqual({ primary: "cheap/tiny", fallbacks: [] });
    expect(cfg.lanes.bad).toBeUndefined();
    expect(cfg.roles.forge).toBe("heartbeat");
    expect(cfg.roles.sage).toEqual({ primary: "s/one", fallbacks: [] });
    expect(cfg.credentialProfiles).toEqual({ gemini: ["GEMINI_API_KEY_2"] });
    expect(cfg.maxAttempts).toBe(20);
    expect(cfg.warnings.join("|")).toMatch(/bad\.primary/);
    expect(cfg.warnings.join("|")).toMatch(/roles\.nope/);
  });

  it("always provides default and background lanes from the global model", () => {
    const cfg = resolveModelRouterConfig({ defaultModel: "g/global" });
    expect(cfg.origin).toBe("builtin");
    expect(cfg.lanes.default).toEqual({ primary: "g/global", fallbacks: [] });
    expect(cfg.lanes.background).toEqual({ primary: "g/global", fallbacks: [] });
  });

  it("migrates the deprecated model_routing block to equivalent lanes", () => {
    const cfg = resolveModelRouterConfig({
      defaultModel: "g/global",
      legacyRouting: { enabled: true, local_model: "llama.cpp/tiny", complex_model: "gemini/flash" },
    });
    expect(cfg.origin).toBe("legacy_model_routing");
    expect(cfg.lanes.default).toEqual({ primary: "llama.cpp/tiny", fallbacks: ["gemini/flash", "g/global"] });
    expect(cfg.lanes.complex).toEqual({ primary: "gemini/flash", fallbacks: ["llama.cpp/tiny", "g/global"] });
    expect(cfg.warnings.join("|")).toMatch(/deprecated/);
  });

  it("legacy enabled:false pins the global model", () => {
    const cfg = resolveModelRouterConfig({
      defaultModel: "g/global",
      legacyRouting: { enabled: false, local_model: "llama.cpp/tiny", complex_model: "gemini/flash" },
    });
    expect(cfg.lanes.default).toEqual({ primary: "g/global", fallbacks: [] });
    expect(cfg.lanes.complex).toBeUndefined();
  });

  it("model_router wins over the legacy block", () => {
    const cfg = resolveModelRouterConfig({
      defaultModel: "g/global",
      modelRouter: { lanes: { default: "a/one" } },
      legacyRouting: { local_model: "llama.cpp/tiny" },
    });
    expect(cfg.origin).toBe("model_router");
    expect(cfg.lanes.default.primary).toBe("a/one");
  });

  it("garbage input never throws", () => {
    for (const bad of [42, "x", [], { lanes: 5 }, { roles: [] }, { credential_profiles: "no" }]) {
      expect(() => resolveModelRouterConfig({ defaultModel: "g/global", modelRouter: bad })).not.toThrow();
    }
  });
});
