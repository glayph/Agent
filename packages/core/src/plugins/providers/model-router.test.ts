import {
  buildModelFallbacks,
  resolveModelRouterConfig,
  resolveRoleModelRoute,
  resolveModelRouteForModel,
} from "./model-router.js";

describe("model router configuration", () => {
  it("parses lane, role and credential profile configuration without mutating the source", () => {
    const source = {
      enabled: true,
      max_attempts: 4,
      lanes: {
        default: { primary: "openai/gpt-main", fallbacks: ["gemini/flash", "gemini/flash", ""] },
        heartbeat: "gemini/flash",
      },
      roles: { forge: "complex", reviewer: { primary: "openai/review", fallbacks: ["gemini/review"] } },
      credential_profiles: { openai: ["OPENAI_API_KEY_BACKUP", "not a secret name"] },
    };
    const original = structuredClone(source);
    const config = resolveModelRouterConfig(source);
    expect(source).toEqual(original);
    expect(config).toMatchObject({
      enabled: true,
      maxAttempts: Number.POSITIVE_INFINITY,
      lanes: {
        default: { primary: "openai/gpt-main", fallbacks: ["gemini/flash"] },
        heartbeat: { primary: "gemini/flash", fallbacks: [] },
      },
      roles: {
        forge: "complex",
        reviewer: { primary: "openai/review", fallbacks: ["gemini/review"] },
      },
      credentialProfiles: { openai: ["OPENAI_API_KEY_BACKUP"] },
    });
  });

  it("ignores legacy attempt ceilings and fails closed for disabled or malformed routes", () => {
    expect(resolveModelRouterConfig({ max_attempts: 100 }).maxAttempts).toBe(Number.POSITIVE_INFINITY);
    expect(resolveModelRouterConfig({ max_attempts: 0 }).maxAttempts).toBe(Number.POSITIVE_INFINITY);
    expect(resolveModelRouterConfig({ enabled: false, lanes: { default: "openai/x" } })).toMatchObject({ enabled: false, lanes: { default: { primary: "openai/x" } } });
    expect(resolveModelRouterConfig({ lanes: { default: 42 }, roles: { bad: [] } })).toMatchObject({ lanes: {}, roles: {} });
  });

  it("resolves role-to-lane and direct role bindings", () => {
    const config = resolveModelRouterConfig({
      lanes: { default: "openai/default", complex: { primary: "openai/complex", fallbacks: ["gemini/pro"] } },
      roles: { forge: "complex", reviewer: { primary: "gemini/review" } },
    });
    expect(resolveRoleModelRoute(config, "forge")).toEqual({ laneName: "complex", route: { primary: "openai/complex", fallbacks: ["gemini/pro"] } });
    expect(resolveRoleModelRoute(config, "reviewer")).toEqual({ laneName: "role:reviewer", route: { primary: "gemini/review", fallbacks: [] } });
    expect(resolveRoleModelRoute(config, "unknown")?.laneName).toBe("default");
    expect(resolveRoleModelRoute({ ...config, enabled: false }, "forge")).toBeUndefined();
  });

  it("resolves the matching lane for explicit/background models after preferring the active role", () => {
    const config = resolveModelRouterConfig({
      lanes: {
        default: { primary: "openai/default", fallbacks: ["openai/default-backup"] },
        heartbeat: { primary: "gemini/heartbeat", fallbacks: ["local/qwen"] },
      },
      roles: { reviewer: { primary: "openai/review", fallbacks: ["gemini/review-backup"] } },
    });
    expect(resolveModelRouteForModel(config, "openai/review", "reviewer")?.laneName).toBe("role:reviewer");
    expect(resolveModelRouteForModel(config, "gemini/heartbeat", "reviewer")?.laneName).toBe("heartbeat");
    expect(resolveModelRouteForModel(config, "not-configured", "reviewer")).toBeUndefined();
  });

  it("orders every explicit model fallback and ignores legacy attempt ceilings", () => {
    expect(buildModelFallbacks({
      primaryModel: "openai/main",
      route: { primary: "openai/main", fallbacks: ["gemini/flash", "local/qwen"] },
      legacyFallbacks: ["local/qwen", "openai/main", "openai/backup"],
      maxAttempts: 3,
    })).toEqual(["gemini/flash", "local/qwen", "openai/backup"]);
    expect(buildModelFallbacks({ route: { fallbacks: ["a", "b"] }, maxAttempts: 1 })).toEqual(["a", "b"]);
    const manyRoutes = Array.from({ length: 32 }, (_, index) => `fallback/model-${index}`);
    expect(buildModelFallbacks({ route: { fallbacks: manyRoutes }, maxAttempts: 2 })).toEqual(manyRoutes);
  });
});
