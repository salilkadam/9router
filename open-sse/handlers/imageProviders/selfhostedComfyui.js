// Self-hosted ComfyUI — text-to-image by submitting a full API-format graph.
//
// The registry's `comfyui` entry is a placeholder (fixed localhost URL, posts a
// bare {prompt}), which ComfyUI does not understand. This adapter does the real
// protocol against a per-connection server:
//
//   POST {base}/prompt {prompt: <graph>, client_id}   -> {prompt_id, node_errors}
//   GET  {base}/history/{prompt_id}                   until it has outputs
//   GET  {base}/view?filename=&subfolder=&type=output -> image bytes
//
// Graphs are the official ComfyUI template shapes, already proven in production
// by the genimage MCP (Qwen-Image-2512) and mcp-comfy (Z-Image-Turbo) against the
// same server. Model FILE names are per-connection overridable through
// providerSpecificData.models.<id>.{unet,clip,vae}, because they are a property
// of what the server has on disk, not of this code.
import { sleep, nowSec } from "./_base.js";

const DEFAULT_BASE_URL = "http://localhost:8188";
const DEFAULT_TIMEOUT_MS = 95000;
const POLL_MS = 1000;
const META = "__selfhostedComfyMeta";

const MODELS = {
  // Qwen-Image-2512 (fp8). True CFG, so the negative prompt actually steers.
  "qwen-image": {
    unet: "qwen_image_2512_fp8_e4m3fn.safetensors",
    clip: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
    clipType: "qwen_image",
    vae: "qwen_image_vae.safetensors",
    shift: 3.1,
    steps: 30,
    cfg: 4.0,
    sampler: "euler",
    trueCfg: true,
  },
  // Z-Image-Turbo (bf16). Distilled: 9 steps, cfg 1, negative is zeroed out.
  "z-image-turbo": {
    unet: "z_image_turbo_bf16.safetensors",
    clip: "qwen_3_4b.safetensors",
    clipType: "lumina2",
    vae: "ae.safetensors",
    shift: 3,
    steps: 9,
    cfg: 1,
    sampler: "res_multistep",
    trueCfg: false,
  },
};

export const SUPPORTED_MODELS = Object.keys(MODELS);

function psd(creds) {
  return creds?.providerSpecificData || {};
}

export function resolveBase(creds) {
  const raw = psd(creds).baseUrl || creds?.baseUrl || DEFAULT_BASE_URL;
  return String(raw).replace(/\/+$/, "").replace(/\/prompt$/, "");
}

function clampDim(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(2048, Math.max(256, Math.round(n / 16) * 16));
}

export function parseSize(body) {
  let w = body.width;
  let h = body.height;
  if ((!w || !h) && typeof body.size === "string") {
    const m = body.size.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (m) [w, h] = [m[1], m[2]];
  }
  return { width: clampDim(w, 1024), height: clampDim(h, 1024) };
}

export function buildGraph(model, body, overrides = {}) {
  const base = MODELS[model];
  if (!base) {
    throw new Error(`selfhosted-comfyui: unknown model '${model}' (supported: ${SUPPORTED_MODELS.join(", ")})`);
  }
  const m = { ...base, ...(overrides[model] || {}) };
  const { width, height } = parseSize(body);
  const batch = Math.min(4, Math.max(1, Number(body.n) || 1));
  const steps = Math.min(60, Math.max(1, Number(body.steps) || m.steps));
  const cfg = body.guidance !== undefined && body.guidance !== null ? Number(body.guidance) : m.cfg;
  const seed = Number.isInteger(body.seed) ? body.seed : Math.floor(Math.random() * 2 ** 48);

  const graph = {
    1: { class_type: "UNETLoader", inputs: { unet_name: m.unet, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: m.clip, type: m.clipType } },
    3: { class_type: "VAELoader", inputs: { vae_name: m.vae } },
    10: { class_type: "ModelSamplingAuraFlow", inputs: { shift: m.shift, model: ["1", 0] } },
    4: { class_type: "CLIPTextEncode", inputs: { text: body.prompt, clip: ["2", 0] } },
    13: { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: batch } },
    5: {
      class_type: "KSampler",
      inputs: {
        seed, steps, cfg, sampler_name: m.sampler, scheduler: "simple", denoise: 1.0,
        model: ["10", 0], positive: ["4", 0], negative: ["11", 0], latent_image: ["13", 0],
      },
    },
    6: { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["3", 0] } },
    9: { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "9router" } },
  };
  graph[11] = m.trueCfg
    ? { class_type: "CLIPTextEncode", inputs: { text: body.negative_prompt || "", clip: ["2", 0] } }
    : { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } };
  return { graph, seed, width, height };
}

function extraHeaders(creds) {
  const h = psd(creds).headers;
  if (!h || typeof h !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(h)) if (typeof v === "string") out[k] = v;
  return out;
}

function historyError(entry) {
  const msgs = entry?.status?.messages || [];
  for (const [kind, data] of msgs) {
    if (kind === "execution_error") {
      return `${data?.node_type || "node"}: ${data?.exception_message || "execution error"}`.trim();
    }
  }
  return null;
}

export default {
  async: true,
  buildUrl: (_model, creds) => `${resolveBase(creds)}/prompt`,
  buildHeaders: (creds, requestBody) => {
    const headers = { "Content-Type": "application/json", Accept: "application/json", ...extraHeaders(creds) };
    const key = creds?.apiKey || creds?.accessToken;
    // A bare ComfyUI ignores Authorization; one behind an auth proxy needs it.
    if (key && key !== "none") headers.Authorization = `Bearer ${key}`;
    const t = Number(psd(creds).timeoutMs);
    Object.defineProperty(headers, META, {
      value: {
        timeoutMs: Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS,
        seed: requestBody?.[META]?.seed,
      },
      enumerable: false,
    });
    return headers;
  },
  buildBody: (model, body, creds) => {
    const { graph, seed } = buildGraph(model, body, psd(creds).models || {});
    const req = { prompt: graph, client_id: `9router-${Date.now().toString(36)}` };
    Object.defineProperty(req, META, { value: { seed }, enumerable: false });
    return req;
  },
  async parseResponse(response, { headers, url }) {
    const base = String(url).replace(/\/prompt$/, "");
    const meta = headers?.[META] || {};
    const budget = meta.timeoutMs || DEFAULT_TIMEOUT_MS;
    const { "Content-Type": _ct, ...h } = headers;

    const submitted = await response.json();
    if (submitted?.node_errors && Object.keys(submitted.node_errors).length) {
      throw new Error(`selfhosted-comfyui: graph rejected: ${JSON.stringify(submitted.node_errors).slice(0, 400)}`);
    }
    const id = submitted?.prompt_id;
    if (!id) throw new Error("selfhosted-comfyui: no prompt_id returned");

    const deadline = Date.now() + budget;
    let entry = null;
    while (!entry) {
      if (Date.now() >= deadline) {
        // Drop it if still queued. Never /interrupt: on a shared server that
        // could kill somebody else's running job.
        await fetch(`${base}/queue`, {
          method: "POST",
          headers: { ...h, "Content-Type": "application/json" },
          body: JSON.stringify({ delete: [id] }),
        }).catch(() => {});
        throw new Error(`selfhosted-comfyui: prompt ${id} not finished after ${Math.round(budget / 1000)}s`);
      }
      await sleep(POLL_MS);
      const r = await fetch(`${base}/history/${id}`, { headers: h });
      if (!r.ok) throw new Error(`selfhosted-comfyui: history -> ${r.status}`);
      const hist = await r.json();
      const e = hist?.[id];
      if (e && (e.status?.completed || e.status?.status_str === "error")) entry = e;
    }
    const err = historyError(entry);
    if (err || entry.status?.status_str === "error") {
      throw new Error(`selfhosted-comfyui: render failed: ${err || "unknown error"}`);
    }

    const data = [];
    for (const out of Object.values(entry.outputs || {})) {
      for (const img of out.images || []) {
        if (img.type && img.type !== "output") continue;
        const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: "output" });
        const r = await fetch(`${base}/view?${q}`, { headers: h });
        if (!r.ok) throw new Error(`selfhosted-comfyui: fetching ${img.filename} -> ${r.status}`);
        data.push({ b64_json: Buffer.from(await r.arrayBuffer()).toString("base64") });
      }
    }
    if (!data.length) throw new Error("selfhosted-comfyui: render finished without images");
    return { created: nowSec(), seed: meta.seed, data };
  },
  normalize: (responseBody) => responseBody,
};
