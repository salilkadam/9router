/**
 * selfhosted-image (OpenAI-shaped, job-aware) and selfhosted-comfyui (native
 * ComfyUI graph) image adapters, driven through handleImageGenerationCore the
 * same way /v1/images/generations does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { getImageAdapter } from "../../open-sse/handlers/imageProviders/index.js";
import { buildGraph, parseSize } from "../../open-sse/handlers/imageProviders/selfhostedComfyui.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";

const originalFetch = global.fetch;
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const bytes = (s) => new Response(Buffer.from(s), { status: 200, headers: { "Content-Type": "image/png" } });

const V2 = {
  apiKey: "box-key",
  providerSpecificData: { baseUrl: "https://gpu.example/v2/", headers: { "X-Extra": "1" }, timeoutMs: 4000 },
};
const COMFY = { apiKey: "none", providerSpecificData: { baseUrl: "http://comfy:8188", timeoutMs: 4000 } };

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

describe("registry wiring", () => {
  it("registers both adapters", () => {
    expect(getImageAdapter("selfhosted-image")).toBeTruthy();
    expect(getImageAdapter("selfhosted-comfyui")).toBeTruthy();
  });

  it("resolves provider-prefixed model ids", async () => {
    const a = await getModelInfoCore("selfhosted-image/qwen-image-2.1", {});
    expect(a).toMatchObject({ provider: "selfhosted-image", model: "qwen-image-2.1" });
    const b = await getModelInfoCore("selfhosted-comfyui/z-image-turbo", {});
    expect(b).toMatchObject({ provider: "selfhosted-comfyui", model: "z-image-turbo" });
  });
});

describe("selfhosted-image", () => {
  it("posts to the per-connection base with key, UA, extra headers and b64_json", async () => {
    global.fetch.mockResolvedValueOnce(json({ created: 1, data: [{ b64_json: "QUJD" }], seed: 7 }));
    const r = await handleImageGenerationCore({
      body: { prompt: "a cat", size: "1344x768", quality: "hd", response_format: "url", seed: 7 },
      modelInfo: { provider: "selfhosted-image", model: "qwen-image-2.1" },
      credentials: V2,
    });
    expect(r.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://gpu.example/v2/images/generations");
    expect(init.headers).toMatchObject({ Authorization: "Bearer box-key", "X-Extra": "1" });
    expect(init.headers["User-Agent"]).toMatch(/^9router-/);
    // internal metadata must not be serialisable onto the wire
    expect(Object.keys(init.headers).some((k) => k.startsWith("__"))).toBe(false);
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ model: "qwen-image-2.1", prompt: "a cat", size: "1344x768", response_format: "b64_json", wait: false, seed: 7 });
    expect(sent.quality).toBeUndefined();
    const out = await r.response.json();
    expect(out.data[0].b64_json).toBe("QUJD");
  });

  it("follows a 202 job to completion and downloads every output", async () => {
    global.fetch
      .mockResolvedValueOnce(json({ object: "job", id: "j1", status: "queued" }, 202))
      .mockResolvedValueOnce(json({ object: "job", id: "j1", status: "running" }))
      .mockResolvedValueOnce(json({
        object: "job", id: "j1", status: "succeeded", model: "qwen-image-2.1", seed: 3, finished_at: 99,
        outputs: [{ index: 0 }, { index: 1 }],
      }))
      .mockResolvedValueOnce(bytes("img0"))
      .mockResolvedValueOnce(bytes("img1"));
    const r = await handleImageGenerationCore({
      body: { prompt: "x", n: 2 },
      modelInfo: { provider: "selfhosted-image", model: "qwen-image-2.1" },
      credentials: V2,
    });
    expect(r.success).toBe(true);
    const out = await r.response.json();
    expect(out.data.map((d) => Buffer.from(d.b64_json, "base64").toString())).toEqual(["img0", "img1"]);
    expect(out.seed).toBe(3);
    expect(global.fetch.mock.calls[1][0]).toBe("https://gpu.example/v2/jobs/j1");
    expect(global.fetch.mock.calls[3][0]).toBe("https://gpu.example/v2/jobs/j1/content?index=0");
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer box-key");
  }, 15000);

  it("cancels a job that outlives timeoutMs and fails (so a combo falls through)", async () => {
    const creds = { ...V2, providerSpecificData: { ...V2.providerSpecificData, timeoutMs: 1 } };
    global.fetch.mockImplementation(async (url, init = {}) => {
      if (init.method === "POST") return json({ object: "job", id: "slow", status: "queued" }, 202);
      if (init.method === "DELETE") return json({ id: "slow", status: "canceled" });
      return json({ object: "job", id: "slow", status: "queued" });
    });
    const r = await handleImageGenerationCore({
      body: { prompt: "x" },
      modelInfo: { provider: "selfhosted-image", model: "qwen-image-2.1" },
      credentials: creds,
    });
    expect(r.success).toBe(false);
    expect(r.status).toBe(502);
    expect(r.error).toMatch(/canceled/);
    const del = global.fetch.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(del?.[0]).toBe("https://gpu.example/v2/jobs/slow");
  }, 10000);

  it("surfaces a failed job as an error", async () => {
    global.fetch
      .mockResolvedValueOnce(json({ object: "job", id: "f", status: "queued" }, 202))
      .mockResolvedValueOnce(json({ object: "job", id: "f", status: "failed", error: "CUDA OOM" }));
    const r = await handleImageGenerationCore({
      body: { prompt: "x" },
      modelInfo: { provider: "selfhosted-image", model: "qwen-image-2.1" },
      credentials: V2,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/CUDA OOM/);
  }, 10000);

  it("passes an upstream 500 through as a failure", async () => {
    global.fetch.mockResolvedValueOnce(json({ detail: "boom" }, 500));
    const r = await handleImageGenerationCore({
      body: { prompt: "x" },
      modelInfo: { provider: "selfhosted-image", model: "qwen-image-2.1" },
      credentials: V2,
    });
    expect(r.success).toBe(false);
    expect(r.status).toBe(500);
  });
});

describe("selfhosted-comfyui graphs", () => {
  it("parses and clamps sizes to /16 within 256..2048", () => {
    expect(parseSize({ size: "1344x768" })).toEqual({ width: 1344, height: 768 });
    expect(parseSize({ size: "100x9000" })).toEqual({ width: 256, height: 2048 });
    expect(parseSize({ width: 1000, height: 990 })).toEqual({ width: 1008, height: 992 });
    expect(parseSize({})).toEqual({ width: 1024, height: 1024 });
  });

  it("qwen-image uses true CFG with an encoded negative", () => {
    const { graph } = buildGraph("qwen-image", { prompt: "p", negative_prompt: "blurry", n: 2, seed: 5 });
    expect(graph[1].inputs.unet_name).toBe("qwen_image_2512_fp8_e4m3fn.safetensors");
    expect(graph[2].inputs.type).toBe("qwen_image");
    expect(graph[11]).toEqual({ class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["2", 0] } });
    expect(graph[5].inputs).toMatchObject({ seed: 5, cfg: 4, steps: 30 });
    expect(graph[13].inputs.batch_size).toBe(2);
  });

  it("z-image-turbo zeroes the negative and runs 9 steps at cfg 1", () => {
    const { graph } = buildGraph("z-image-turbo", { prompt: "p" });
    expect(graph[11].class_type).toBe("ConditioningZeroOut");
    expect(graph[5].inputs).toMatchObject({ steps: 9, cfg: 1, sampler_name: "res_multistep" });
    expect(graph[2].inputs).toMatchObject({ clip_name: "qwen_3_4b.safetensors", type: "lumina2" });
  });

  it("honours per-connection model file overrides and rejects unknown models", () => {
    const { graph } = buildGraph("qwen-image", { prompt: "p" }, { "qwen-image": { unet: "other.safetensors" } });
    expect(graph[1].inputs.unet_name).toBe("other.safetensors");
    expect(() => buildGraph("sdxl", { prompt: "p" })).toThrow(/unknown model/);
  });
});

describe("selfhosted-comfyui protocol", () => {
  it("submits, polls history and downloads outputs", async () => {
    global.fetch
      .mockResolvedValueOnce(json({ prompt_id: "p1", node_errors: {} }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({
        p1: {
          status: { completed: true, status_str: "success", messages: [] },
          outputs: { 9: { images: [{ filename: "9router_0001.png", subfolder: "", type: "output" }] } },
        },
      }))
      .mockResolvedValueOnce(bytes("png"));
    const r = await handleImageGenerationCore({
      body: { prompt: "hello", size: "512x512", seed: 11 },
      modelInfo: { provider: "selfhosted-comfyui", model: "qwen-image" },
      credentials: COMFY,
    });
    expect(r.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("http://comfy:8188/prompt");
    expect(init.headers.Authorization).toBeUndefined(); // key "none"
    const sent = JSON.parse(init.body);
    expect(sent.prompt[4].inputs.text).toBe("hello");
    expect(sent.prompt[13].inputs).toMatchObject({ width: 512, height: 512 });
    expect(global.fetch.mock.calls[3][0]).toBe("http://comfy:8188/view?filename=9router_0001.png&subfolder=&type=output");
    const out = await r.response.json();
    expect(Buffer.from(out.data[0].b64_json, "base64").toString()).toBe("png");
    expect(out.seed).toBe(11);
  }, 10000);

  it("reports node_errors and execution errors", async () => {
    global.fetch.mockResolvedValueOnce(json({ prompt_id: "p", node_errors: { 1: { errors: ["missing"] } } }));
    let r = await handleImageGenerationCore({
      body: { prompt: "x" },
      modelInfo: { provider: "selfhosted-comfyui", model: "qwen-image" },
      credentials: COMFY,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/graph rejected/);

    global.fetch
      .mockResolvedValueOnce(json({ prompt_id: "p2", node_errors: {} }))
      .mockResolvedValueOnce(json({
        p2: { status: { completed: false, status_str: "error", messages: [["execution_error", { node_type: "KSampler", exception_message: "OOM" }]] } },
      }));
    r = await handleImageGenerationCore({
      body: { prompt: "x" },
      modelInfo: { provider: "selfhosted-comfyui", model: "qwen-image" },
      credentials: COMFY,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/KSampler: OOM/);
  }, 10000);

  it("rejects an unknown model as a 400 before any request", async () => {
    const r = await handleImageGenerationCore({
      body: { prompt: "x" },
      modelInfo: { provider: "selfhosted-comfyui", model: "sdxl" },
      credentials: COMFY,
    });
    expect(r.success).toBe(false);
    expect(r.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
