import { describe, expect, it } from "vitest";
import { checkFallbackError } from "open-sse/services/accountFallback.js";
import { handleComboChat } from "open-sse/services/combo.js";
import { TRANSIENT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";

// 2026-09-20: a vLLM 400 ("maximum context length is 131072 tokens") reached
// checkFallbackError with no matching rule and took the transient default —
// a 30s cooldown on the whole connection. A 4-token request from another
// caller then failed with the same error. A 4xx that rejects THIS request
// says nothing about the account.
const contextTooLong =
  "This model's maximum context length is 131072 tokens. However, you requested 135000 tokens.";

describe("checkFallbackError — account scope: client-side rejections never cool an account down", () => {
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

  // xai answers a bad key with 400, not 401 (src/app/api/providers/validate/route.js).
  it.each([
    "Incorrect API key provided: xai-abc. You can find your API key at https://console.x.ai",
    "invalid api key",
    '{"error":{"type":"authentication_error","message":"bad key"}}',
    "Unauthorized",
  ])("a 400 whose body is a credential rejection still locks the account: %s", (body) => {
    const r = checkFallbackError(400, body);
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThanOrEqual(60_000);
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

describe("checkFallbackError — model scope (combos) still falls through on a 400", () => {
  it.each([400, 413, 422])("status %i, scope model → fallback to next member", (status) => {
    const r = checkFallbackError(status, contextTooLong, 0, { scope: "model" });
    expect(r.shouldFallback).toBe(true);
  });
});

describe("handleComboChat (real) — a member's 400 does not end the combo", () => {
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const reply = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("first member rejects on context length, second member serves it", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      if (modelStr === "small/ctx-8k") return reply(400, { error: { message: contextTooLong } });
      return reply(200, { id: "ok", choices: [{ message: { content: "served" } }] });
    };
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["small/ctx-8k", "big/ctx-128k"],
      handleSingleModel, log, comboName: "t", comboStrategy: "priority", autoSwitch: false,
    });
    expect(calls).toEqual(["small/ctx-8k", "big/ctx-128k"]);
    expect(res.status).toBe(200);
  });
});
