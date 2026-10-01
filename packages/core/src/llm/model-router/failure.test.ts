import {
  LLMAPIError,
  LLMEntitlementError,
  LLMMissingCredentialError,
  LLMRateLimitError,
  LLMTimeoutError,
} from "../provider/errors.js";
import { classifyFailure } from "./failure.js";

describe("classifyFailure", () => {
  it.each([
    [new LLMRateLimitError("x", { providerId: "p", status: 429 }), "rate_limit", true, true],
    [new LLMTimeoutError("x", { providerId: "p" }), "timeout", true, false],
    [new LLMEntitlementError("x", { providerId: "p" }), "billing", true, true],
    [new LLMMissingCredentialError("x", { providerId: "p" }), "auth", true, true],
    [new LLMMissingCredentialError("No supported provider plugin matches model"), "model_not_found", true, false],
    [new LLMAPIError("x", { providerId: "p", status: 503 }), "server_error", true, false],
    [new LLMAPIError("x", { providerId: "p", status: 404 }), "model_not_found", true, false],
    [new LLMAPIError("Provider p request failed.", { providerId: "p", status: 0 }), "network", true, false],
    [new LLMAPIError("No provider plugin matches model \"q\"."), "model_not_found", true, false],
    [new LLMAPIError("maximum context length exceeded", { providerId: "p", status: 400 }), "context_overflow", true, false],
    [new LLMAPIError("bad schema", { providerId: "p", status: 400 }), "bad_request", false, false],
    [new LLMAPIError("does not support audio input", { providerId: "p" }), "bad_request", false, false],
    [Object.assign(new Error("boom"), { code: "ECONNRESET" }), "network", true, false],
    [new TypeError("bug"), "unknown", false, false],
  ])("%#", (error, kind, failover, rotate) => {
    expect(classifyFailure(error)).toEqual({ kind, failover, rotateCredential: rotate });
  });

  it("an aborted call is never failed over", () => {
    expect(classifyFailure(new LLMTimeoutError("x"), { aborted: true }).failover).toBe(false);
    expect(classifyFailure(Object.assign(new Error("x"), { name: "AbortError" })).kind).toBe("aborted");
  });
});
