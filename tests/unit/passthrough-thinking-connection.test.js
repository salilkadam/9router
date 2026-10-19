import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";

// The gpu-ai connection points at our own mcp-api-server, which maps OpenAI
// `reasoning_effort` onto the local model's chat template. Capability-based thinking
// normalisation either stripped it (qwen3.8-* is unknown, so "cannot reason") or
// rewrote it into DashScope's enable_thinking/thinking_budget (qwen3.6-*), which the
// upstream ignores. A connection can now opt out with providerSpecificData.passthroughThinking.

const PROVIDER = "openai-compatible-chat-test";
const body = (model, extra = {}) => ({
  model,
  messages: [{ role: "user", content: "hi" }],
  stream: true,
  ...extra,
});
const translate = (model, extra, credentials) =>
  translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, model, body(model, extra), true, credentials, PROVIDER);

describe("connection-level passthroughThinking", () => {
  const optIn = { providerSpecificData: { passthroughThinking: true } };

  it.each(["qwen3.8-flash-next", "qwen3.8-flash-next-think", "qwen3.6-35b-a3b-fp8"])(
    "keeps the client's reasoning_effort verbatim for %s when the connection opts in",
    (model) => {
      const out = translate(model, { reasoning_effort: "high" }, optIn);
      expect(out.reasoning_effort).toBe("high");
      expect(out.enable_thinking).toBeUndefined();
      expect(out.thinking_budget).toBeUndefined();
    },
  );

  it("still strips reasoning_effort for an unknown model without the opt-in (unchanged)", () => {
    const out = translate("qwen3.8-flash-next", { reasoning_effort: "high" }, { providerSpecificData: {} });
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("still rewrites qwen3.6 into the qwen-native shape without the opt-in (unchanged)", () => {
    const out = translate("qwen3.6-35b-a3b-fp8", { reasoning_effort: "high" }, null);
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.enable_thinking).toBe(true);
  });

  it("only a literal true opts in", () => {
    const out = translate("qwen3.8-flash-next", { reasoning_effort: "medium" }, { providerSpecificData: { passthroughThinking: "yes" } });
    expect(out.reasoning_effort).toBeUndefined();
  });
});
