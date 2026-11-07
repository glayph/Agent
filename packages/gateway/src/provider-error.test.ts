import { describe, expect, it } from "@jest/globals";
import { classifyProviderHttpError, ProviderRequestError } from "./provider-error.js";

describe("provider HTTP error categories", () => {
  it("uses HTTP status and structured codes, not free-form error wording", () => {
    expect(classifyProviderHttpError(402)).toBe("provider_entitlement");
    expect(classifyProviderHttpError(403, "insufficient_quota")).toBe("provider_entitlement");
    expect(classifyProviderHttpError(429, "insufficient_quota")).toBe("provider_entitlement");
    expect(classifyProviderHttpError(429, "rate_limit_exceeded")).toBe("provider_rate_limit");
    expect(classifyProviderHttpError(403, "permission_denied")).toBe("provider_authorization");
    expect(classifyProviderHttpError(401)).toBe("provider_api_key");
    expect(classifyProviderHttpError(404, "model_not_found")).toBe("model_not_found");
    expect(classifyProviderHttpError(400)).toBe("provider_bad_request");
    expect(classifyProviderHttpError(429)).toBe("provider_rate_limit");
    expect(classifyProviderHttpError(503)).toBe("provider_unavailable");
  });
});


describe("provider diagnostic redaction", () => {
  it("redacts exact configured secrets echoed by an upstream provider", () => {
    const key = "provider-secret-value-1234";
    const error = new ProviderRequestError(`Provider echoed ${key}`, "provider_unavailable", "gemini", 503, undefined, undefined, [key]);
    expect(error.message).not.toContain(key);
    expect(error.message).toContain("[redacted]");
  });
});
