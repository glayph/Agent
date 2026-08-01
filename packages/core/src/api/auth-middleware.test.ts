import {
  apiKeyFromHeaders,
  authenticateApiKeyHeaders,
  isApiKeyAuthEnabled,
  validateApiKeyConfiguration,
} from "./auth-middleware.js";

describe("API key auth configuration", () => {
  const previousEnabled = process.env["ENABLE_API_KEY_AUTH"];
  const previousSecret = process.env["API_KEY_SECRET"];

  afterEach(() => {
    if (previousEnabled === undefined)
      delete process.env["ENABLE_API_KEY_AUTH"];
    else process.env["ENABLE_API_KEY_AUTH"] = previousEnabled;
    if (previousSecret === undefined) delete process.env["API_KEY_SECRET"];
    else process.env["API_KEY_SECRET"] = previousSecret;
  });

  it("does not require API_KEY_SECRET when API auth is disabled", () => {
    process.env["ENABLE_API_KEY_AUTH"] = "false";
    delete process.env["API_KEY_SECRET"];

    expect(isApiKeyAuthEnabled()).toBe(false);
    expect(() => validateApiKeyConfiguration()).not.toThrow();
  });

  it("rejects weak API_KEY_SECRET when API auth is enabled", () => {
    process.env["ENABLE_API_KEY_AUTH"] = "true";
    process.env["API_KEY_SECRET"] = "Hiro-dev-key";

    expect(() => validateApiKeyConfiguration()).toThrow(/unsafe default/);
  });

  it("extracts API keys from X-API-Key and Authorization headers", () => {
    expect(apiKeyFromHeaders({ "x-api-key": "from-header" })).toBe(
      "from-header",
    );
    expect(
      apiKeyFromHeaders({ authorization: "Bearer from-authorization" }),
    ).toBe("from-authorization");
  });

  it("authenticates a valid API key header", () => {
    process.env["API_KEY_SECRET"] = "strong-secret-value";

    expect(
      authenticateApiKeyHeaders({ "x-api-key": "strong-secret-value" }),
    ).toEqual({ ok: true });
  });

  it("rejects missing API keys when mandatory authentication is used", () => {
    process.env["API_KEY_SECRET"] = "strong-secret-value";

    expect(authenticateApiKeyHeaders({})).toEqual({
      ok: false,
      status: 401,
      error: "Unauthorized",
      detail: "Invalid or missing API key",
    });
  });

  it("reports mandatory API key auth misconfiguration", () => {
    delete process.env["API_KEY_SECRET"];

    expect(authenticateApiKeyHeaders({})).toMatchObject({
      ok: false,
      status: 500,
      error: "API key authentication is misconfigured",
    });
  });
});
