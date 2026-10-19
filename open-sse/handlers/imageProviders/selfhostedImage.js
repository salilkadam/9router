// Self-hosted, OpenAI-shaped image API — POST {baseUrl}/images/generations.
//
// Built for the Bionic GPU API v2 (ComfyUI on a dedicated A100), but anything
// that speaks the OpenAI images shape works. Two things set it apart from the
// stock openai adapter, which reads a FIXED url from the registry entry:
//
//  1. The endpoint comes from the connection (providerSpecificData.baseUrl), the
//     same per-connection override the selfhosted-tts/-stt/-embedding entries use.
//  2. It understands an asynchronous job reply. The v2 API answers 202 + a job
//     object when a render is still queued (e.g. behind a long video render). We
//     submit with wait=false and own the whole timeline: poll the job for at most
//     `timeoutMs`, then cancel it and fail, so a combo can fall through to the
//     next member well inside the gateway's read timeout instead of the client
//     waiting on a busy GPU.
//
// The upstream is always asked for b64_json. Upstream job URLs need the
// upstream's own key, which a 9router client never has, so a url response would
// be useless to the caller.
import { sleep, nowSec } from "./_base.js";

const DEFAULT_BASE_URL = "http://localhost:8000/v1";
const DEFAULT_TIMEOUT_MS = 75000;
const POLL_MS = 1500;
// Cloudflare-fronted origins reject library user agents (error 1010), and
// undici's default "node" is one of them.
const DEFAULT_UA = "9router-selfhosted-image/1.0";
const META = "__selfhostedImageMeta";

// Fields the OpenAI shape and the v2 API share, plus v2's tuning knobs. Anything
// else (quality, style, ...) is dropped rather than risking a 422 upstream.
const PASSTHROUGH = ["negative_prompt", "width", "height", "steps", "guidance", "seed"];

function psd(creds) {
  return creds?.providerSpecificData || {};
}

export function resolveBase(creds) {
  const raw = psd(creds).baseUrl || creds?.baseUrl || DEFAULT_BASE_URL;
  // Tolerate the full endpoint being pasted as the base.
  return String(raw).replace(/\/+$/, "").replace(/\/images\/generations$/, "");
}

function timeoutMs(creds) {
  const t = Number(psd(creds).timeoutMs);
  return Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS;
}

function extraHeaders(creds) {
  const h = psd(creds).headers;
  if (!h || typeof h !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(h)) if (typeof v === "string") out[k] = v;
  return out;
}

async function fetchJson(url, headers, init = {}) {
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`self-hosted image ${init.method || "GET"} ${new URL(url).pathname} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function jobOutputsToB64(base, job, headers) {
  const data = [];
  for (const out of job.outputs || []) {
    const idx = out.index ?? data.length;
    const res = await fetch(`${base}/jobs/${job.id}/content?index=${idx}`, { headers });
    if (!res.ok) throw new Error(`self-hosted image: fetching output ${idx} failed (${res.status})`);
    data.push({ b64_json: Buffer.from(await res.arrayBuffer()).toString("base64") });
  }
  return data;
}

export default {
  async: true,
  buildUrl: (_model, creds) => `${resolveBase(creds)}/images/generations`,
  buildHeaders: (creds) => {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": DEFAULT_UA,
      ...extraHeaders(creds),
    };
    const key = creds?.apiKey || creds?.accessToken;
    if (key) headers.Authorization = `Bearer ${key}`;
    // parseResponse only receives what the core hands it (headers, url, ...),
    // not the credentials, so the poll budget rides on the headers object as a
    // NON-enumerable property: fetch() and object spread both skip it, so it
    // never goes on the wire.
    Object.defineProperty(headers, META, { value: { timeoutMs: timeoutMs(creds) }, enumerable: false });
    return headers;
  },
  buildBody: (model, body) => {
    const req = {
      model,
      prompt: body.prompt,
      n: body.n || 1,
      response_format: "b64_json",
      wait: false,
    };
    if (body.size && !body.width && !body.height) req.size = body.size;
    for (const f of PASSTHROUGH) if (body[f] !== undefined && body[f] !== null) req[f] = body[f];
    return req;
  },
  async parseResponse(response, { headers, url }) {
    const base = String(url).replace(/\/images\/generations$/, "");
    const budget = headers?.[META]?.timeoutMs || DEFAULT_TIMEOUT_MS;
    const { "Content-Type": _ct, ...h } = headers;
    const first = await response.json();

    // Synchronous OpenAI-style answer.
    if (Array.isArray(first?.data)) return first;

    if (first?.object !== "job" || !first.id) {
      throw new Error("self-hosted image: response is neither an image list nor a job");
    }

    const deadline = Date.now() + budget;
    let job = first;
    while (job.status === "queued" || job.status === "running") {
      if (Date.now() >= deadline) {
        // Free the GPU slot we no longer want, then let the combo move on.
        await fetch(`${base}/jobs/${job.id}`, { method: "DELETE", headers: h }).catch(() => {});
        throw new Error(`self-hosted image: job ${job.id} still ${job.status} after ${Math.round(budget / 1000)}s (canceled)`);
      }
      await sleep(POLL_MS);
      job = await fetchJson(`${base}/jobs/${job.id}`, h);
    }
    if (job.status !== "succeeded") {
      throw new Error(`self-hosted image: job ${job.id} ${job.status}: ${job.error || "no detail"}`);
    }
    return {
      created: job.finished_at ? Math.floor(job.finished_at) : nowSec(),
      model: job.model,
      seed: job.seed,
      render_seconds: job.render_seconds,
      data: await jobOutputsToB64(base, job, h),
    };
  },
  normalize: (responseBody) => {
    if (Array.isArray(responseBody?.data)) {
      return { ...responseBody, created: responseBody.created || nowSec() };
    }
    return { created: nowSec(), data: [] };
  },
};

