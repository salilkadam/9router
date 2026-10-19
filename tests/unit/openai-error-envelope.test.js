import { describe, expect, it } from "vitest";

import {
  buildErrorBody,
  errorResponse,
  unavailableResponse,
} from "../../open-sse/utils/error.js";

// OpenAI's error object is {message, type, code, param}. `param` is nullable but
// present, and it is the only field that says WHICH input was rejected. A caller
// using a stock SDK reads these four and nothing else, so an error missing them
// arrives as an opaque status code.
const OPENAI_ERROR_FIELDS = ["code", "message", "param", "type"];

describe("OpenAI error envelope", () => {
  it("emits all four fields on every mapped status", () => {
    for (const status of [400, 401, 403, 404, 406, 429, 500, 502, 503, 504]) {
      expect(Object.keys(buildErrorBody(status, "x").error).sort())
        .toEqual(OPENAI_ERROR_FIELDS);
    }
  });

  it("emits all four fields on an unmapped status", () => {
    expect(buildErrorBody(418, "teapot").error)
      .toEqual({ message: "teapot", type: "invalid_request_error", code: "", param: null });
  });

  it("defaults param to null rather than omitting it", () => {
    expect(buildErrorBody(401, "Invalid API key provided").error.param).toBeNull();
  });

  it("carries param when the caller names the offending field", () => {
    expect(buildErrorBody(400, "Missing model", "model").error)
      .toEqual({
        message: "Missing model",
        type: "invalid_request_error",
        code: "bad_request",
        param: "model",
      });
  });

  it("forwards param through errorResponse", async () => {
    const body = await errorResponse(400, "Missing model", "model").json();
    expect(body.error.param).toBe("model");
  });

  // Regression: this path emitted {error:{message}} alone, so a caller that hit
  // the all-accounts-rate-limited case got a 429 with no type and no code.
  it("gives unavailableResponse the same envelope", async () => {
    const res = unavailableResponse(
      429,
      "All accounts rate limited",
      new Date(Date.now() + 30_000).toISOString(),
      "reset after 30s",
    );
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);

    const body = await res.json();
    expect(Object.keys(body.error).sort()).toEqual(OPENAI_ERROR_FIELDS);
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toContain("reset after 30s");
  });
});
