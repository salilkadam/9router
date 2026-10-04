import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { hasValuableContent, normalizeOpenAIReasoningDelta } from "../../open-sse/utils/streamHelpers.js";
import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

// 2026-10-03: the gpu-ai LLM moved to a vLLM build that streams thinking as `delta.reasoning`
// (not `delta.reasoning_content`). hasValuableContent() only knew reasoning_content, so every
// reasoning-only chunk was dropped in passthrough: clients (Zed) saw a long silence, and when
// the reasoning used the whole max_completion_tokens budget, an empty answer.

const chunk = (delta, extra = {}) => ({
  id: "chatcmpl-0123456789abcdef",
  object: "chat.completion.chunk",
  created: 1791073655,
  model: "qwen3.6-35b-a3b-fp8-think",
  choices: [{ index: 0, delta, finish_reason: null, ...extra }],
});

async function pipe(stream, lines) {
  const encoder = new TextEncoder();
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.map((l) => `data: ${typeof l === "string" ? l : JSON.stringify(l)}\n\n`).join("")));
      controller.close();
    },
  });
  const reader = input.pipeThrough(stream).getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const dataEvents = (text) => text.split("\n")
  .filter((l) => l.startsWith("data:") && l.slice(5).trim() !== "[DONE]")
  .map((l) => JSON.parse(l.slice(5).trim()));

describe("normalizeOpenAIReasoningDelta", () => {
  it("mirrors delta.reasoning into reasoning_content and keeps reasoning", () => {
    const c = chunk({ reasoning: "We need" });
    expect(normalizeOpenAIReasoningDelta(c)).toBe(true);
    expect(c.choices[0].delta).toEqual({ reasoning: "We need", reasoning_content: "We need" });
  });

  it("leaves an existing reasoning_content alone", () => {
    const c = chunk({ reasoning: "a", reasoning_content: "b" });
    expect(normalizeOpenAIReasoningDelta(c)).toBe(false);
    expect(c.choices[0].delta.reasoning_content).toBe("b");
  });

  it("ignores empty reasoning and non-chat chunks", () => {
    expect(normalizeOpenAIReasoningDelta(chunk({ reasoning: "" }))).toBe(false);
    expect(normalizeOpenAIReasoningDelta({ type: "content_block_delta" })).toBe(false);
  });
});

describe("hasValuableContent", () => {
  it("treats a reasoning-only OpenAI delta as valuable", () => {
    expect(hasValuableContent(chunk({ reasoning: "We need" }), FORMATS.OPENAI)).toBeTruthy();
  });
});

describe("passthrough stream keeps vLLM `delta.reasoning` chunks", () => {
  it("forwards reasoning-only chunks with both field names, then the answer", async () => {
    const out = dataEvents(await pipe(createPassthroughStreamWithLogger("openai-compatible-chat-test", null, "qwen3.6-35b-a3b-fp8-think"), [
      chunk({ role: "assistant", content: "" }),
      chunk({ reasoning: "We need" }),
      chunk({ reasoning: " to check." }),
      chunk({ content: "No." }),
      chunk({}, { finish_reason: "stop" }),
      "[DONE]",
    ]));
    const reasoning = out.map((e) => e.choices?.[0]?.delta?.reasoning_content || "").join("");
    const reasoningRaw = out.map((e) => e.choices?.[0]?.delta?.reasoning || "").join("");
    const content = out.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(reasoning).toBe("We need to check.");
    expect(reasoningRaw).toBe("We need to check.");
    expect(content).toBe("No.");
  });
});

describe("translate stream sees vLLM `delta.reasoning`", () => {
  it("emits Claude thinking for an OpenAI upstream that streams delta.reasoning", async () => {
    // (targetFormat = upstream provider format, sourceFormat = client format)
    const text = await pipe(createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai-compatible-chat-test", null, null, "qwen3.6-35b-a3b-fp8-think"), [
      chunk({ role: "assistant", content: "" }),
      chunk({ reasoning: "We need" }),
      chunk({ content: "No." }),
      chunk({}, { finish_reason: "stop" }),
      "[DONE]",
    ]);
    expect(text).toContain("We need");
    expect(text).toContain("No.");
  });
});
