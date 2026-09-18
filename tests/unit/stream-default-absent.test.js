// Regression guard for 40a0de0f: `stream` is OPTIONAL in the OpenAI spec and
// defaults to FALSE. The gateway once read `body.stream !== false`, so a client
// that simply omitted the field was handed `Content-Type: text/event-stream`
// carrying a bare JSON object — neither valid JSON nor valid SSE.
//
// The `Accept` header here is `*/*` ON PURPOSE. `Accept: application/json`
// takes a separate escape hatch further down chatCore, which would make this
// test pass against the broken form too. `*/*` (curl, most HTTP libraries,
// several SDKs) is the case that actually broke.
//
// Provider is a NON-forceStream provider: openai/codex/commandcode force
// streaming regardless of the body (see force-stream-config.test.js).
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

// Only the three side-effecting edges are mocked: the upstream call (network),
// the request logger (writes log files) and usageDb (writes the database).
// Everything else — format detection, the translator, the provider registry,
// the stream decision itself — runs for real.
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

// A provider with forceStream unset — the decision must come from the body.
const PROVIDER = "deepseek";
const MODEL = "deepseek-chat";

function makeOptions(bodyStream) {
  const body = { model: MODEL, messages: [{ role: "user", content: "hello" }] };
  if (bodyStream !== undefined) body.stream = bodyStream;

  return {
    body,
    modelInfo: { provider: PROVIDER, model: MODEL },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { accept: "*/*" },
    },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("OpenAI-spec `stream` default", () => {
  beforeEach(() => {
    executeMock.mockReset();
    // The upstream call itself is irrelevant; the assertion is on what chatCore
    // decided before calling it.
    executeMock.mockRejectedValue(new Error("boom"));
  });

  it("the provider chosen for this test does not force streaming", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    expect(PROVIDERS[PROVIDER]?.forceStream).not.toBe(true);
  });

  it("absent `stream` is NOT a stream, even for an Accept: */* client", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    await handleChatCore(makeOptions(undefined));
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].stream).toBe(false);
  });

  it("explicit `stream: false` is not a stream", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    await handleChatCore(makeOptions(false));
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].stream).toBe(false);
  });

  // Counterweight: without this, "always false" would also pass.
  it("explicit `stream: true` still streams", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    await handleChatCore(makeOptions(true));
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].stream).toBe(true);
  });
});
