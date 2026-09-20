import { describe, expect, it } from "vitest";
import { checkFallbackError } from "open-sse/services/accountFallback.js";
import { TRANSIENT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";

// 2026-09-20: a vLLM 400 ("maximum context length is 131072 tokens") reached
// checkFallbackError with no matching rule and took the transient default —
// a 30s cooldown on the whole connection. A 4-token request from another
// caller then failed with the same error. A 4xx that rejects THIS request
// says nothing about the account.
describe("checkFallbackError — client-side rejections never cool an account down", () => {
  const contextTooLong =
    "This model's maximum context length is 131072 tokens. However, you requested 135000 tokens.";

  it.each([400, 413, 422])("status %i with an unmatched body → no fallback, no cooldown", (status) => {
    const r = checkFallbackError(status, contextTooLong);
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("a 400 whose body names a rate limit still backs off (text rules win)", () => {
    const r = checkFallbackError(400, "rate limit exceeded for this key");
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
    expect(r.newBackoffLevel).toBe(1);
  });

  it("an unclassified 500 keeps the transient cooldown (unchanged behaviour)", () => {
    const r = checkFallbackError(500, "internal error");
    expect(r).toEqual({ shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS });
  });

  it("status rules for 401/403/404/429 are unchanged", () => {
    expect(checkFallbackError(401, "").shouldFallback).toBe(true);
    expect(checkFallbackError(404, "").cooldownMs).toBeGreaterThan(0);
    expect(checkFallbackError(429, "").newBackoffLevel).toBe(1);
  });
});
