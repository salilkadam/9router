// Locks BaseExecutor.execute retry/fallback behavior (docs 04 GAP #1, docs 11 §7).
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the network layer so we can script upstream responses.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");

function res(status) {
  return { status, headers: { get: () => "" } };
}

function makeExec(config) {
  const ex = new BaseExecutor("test", config);
  // make headers trivial; credentials empty
  return ex;
}

const creds = { apiKey: "k" };

beforeEach(() => { fetchMock.mockReset(); });

describe("BaseExecutor.execute — retry by status (config-driven)", () => {
  it("retries 502 `attempts` times then succeeds", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops after exhausting 502 attempts on a single url and throws", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 2, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(502));
    // single url: 1 initial + 2 retries = 3 calls, then returns the 502 response (no fallback url)
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("BaseExecutor.execute — baseUrls fallback", () => {
  it("falls over to the next url on 429 (shouldRetry)", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 429: { attempts: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(429)) // url[0] → fallback
      .mockResolvedValueOnce(res(200)); // url[1] ok
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(out.url).toBe("https://b/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("BaseExecutor.execute — network error retry/fallback", () => {
  it("maps network exception to 502 retry config", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 1, delayMs: 0 } } });
    fetchMock
      .mockImplementationOnce(async () => { throw new Error("ECONNRESET"); })
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the only url fails with network error and no retries left", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 0 } } });
    // mockImplementationOnce (not persistent) avoids vitest flagging a reused rejection.
    fetchMock.mockImplementationOnce(async () => { throw new Error("boom"); });
    let thrown = null;
    try {
      await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    } catch (e) {
      thrown = e;
    }
    expect(thrown?.message).toBe("boom");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("BaseExecutor.execute — computeRetryDelay hook veto", () => {
  it("only invokes computeRetryDelay when status has retry config", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 1, delayMs: 0 } } });
    ex.computeRetryDelay = vi.fn().mockResolvedValue(0);
    fetchMock.mockResolvedValueOnce(res(500));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(500);
    expect(ex.computeRetryDelay).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hook returning false skips retry (uses fallback path)", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 429: { attempts: 5, delayMs: 0 } } });
    ex.computeRetryDelay = vi.fn().mockResolvedValue(false);
    fetchMock.mockResolvedValueOnce(res(429));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    // hook vetoes retry → no fallback url → returns the 429 response as-is
    expect(out.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Upstream that never sends headers: settles only via the abort signal, like a
// vLLM request queued past --max-num-seqs behind mcp-api-server. Per the Fetch
// spec, fetch rejects with signal.reason — so abort(new Error(...)) surfaces as
// that Error, not as an AbortError (only a reason-less abort() yields one).
function hangUntilAborted(_url, opts) {
  return new Promise((_, reject) => {
    opts?.signal?.addEventListener("abort", () => reject(opts.signal.reason));
  });
}

describe("BaseExecutor.execute — per-connection connect timeout (combo failover)", () => {
  it("uses providerSpecificData.timeoutMs over the registry timeoutMs", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", timeoutMs: 10_000, retry: { 502: { attempts: 0 } } });
    fetchMock.mockImplementation(hangUntilAborted);
    const t0 = Date.now();
    await expect(ex.execute({
      model: "m", body: {}, stream: false,
      credentials: { ...creds, providerSpecificData: { timeoutMs: 50 } },
    })).rejects.toThrow(/connect timeout/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("does not retry the same url after a connect timeout, even with 502 retries configured", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 0 } } });
    fetchMock.mockImplementation(hangUntilAborted);
    await expect(ex.execute({
      model: "m", body: {}, stream: false,
      credentials: { ...creds, providerSpecificData: { timeoutMs: 50 } },
    })).rejects.toThrow(/connect timeout/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a connect timeout as a plain Error, not an AbortError (chatCore maps AbortError to 499 = client gone)", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 0 } } });
    fetchMock.mockImplementation(hangUntilAborted);
    let thrown = null;
    try {
      await ex.execute({ model: "m", body: {}, stream: false, credentials: { ...creds, providerSpecificData: { timeoutMs: 50 } } });
    } catch (e) { thrown = e; }
    expect(thrown).not.toBeNull();
    expect(thrown.name).not.toBe("AbortError");
  });

  it("still propagates a caller abort (client disconnect) as AbortError", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 0 } } });
    fetchMock.mockImplementation(hangUntilAborted);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    let thrown = null;
    try {
      await ex.execute({ model: "m", body: {}, stream: false, signal: ctrl.signal, credentials: { ...creds, providerSpecificData: { timeoutMs: 5_000 } } });
    } catch (e) { thrown = e; }
    expect(thrown?.name).toBe("AbortError");
  });
});
