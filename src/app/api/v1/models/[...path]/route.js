import { buildCatalogue, buildModelsList } from "../route.js";

// URL slug → service kind(s). `web` covers both webSearch and webFetch.
const KIND_SLUG_MAP = {
  "image": ["image"],
  "tts": ["tts"],
  "stt": ["stt"],
  "embedding": ["embedding"],
  "image-to-text": ["imageToText"],
  "web": ["webSearch", "webFetch"],
};

// Every kind buildModelsList knows. A model that is only advertised under one
// of the per-kind listings above is still a model this router serves, so
// retrieve must find it too.
const ALL_KINDS = ["llm", ...new Set(Object.values(KIND_SLUG_MAP).flat())];

const CORS = { "Access-Control-Allow-Origin": "*" };

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      ...CORS,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * Resolve one model id against what this router advertises.
 *
 * Checked in the order a client would meet them: the GET /v1/models catalogue
 * first (own LLM entries plus the merged upstream), then the per-kind lists.
 * The match is exact -- OpenAI's retrieve does not alias, and `qwen` must
 * not silently answer for `gpu/qwen`.
 *
 * @returns {Promise<object|null>} the Model object as the list returns it
 */
export async function findModel(id) {
  if (typeof id !== "string" || id.trim() === "") return null;
  const catalogue = await buildCatalogue();
  const hit = catalogue.find((m) => m.id === id);
  if (hit) return hit;
  const others = await buildModelsList(ALL_KINDS.filter((k) => k !== "llm"));
  return others.find((m) => m.id === id) || null;
}

/**
 * GET /v1/models/{kind}  - OpenAI-compatible models list filtered by capability.
 *                          Supported kinds: image, tts, stt, embedding, image-to-text, web.
 * GET /v1/models/{id}    - OpenAI-compatible retrieve. The id may contain
 *                          slashes (gpu/qwen3.5-27b-fp8), hence the catch-all.
 *
 * A single-segment path that names a kind is a kind listing; anything else is
 * a model id. Both /v1/models and this route resolve from buildCatalogue, so
 * an id the list returns is one retrieve can find.
 */
export async function GET(_request, { params }) {
  try {
    const { path } = await params;
    const segments = Array.isArray(path) ? path : [path];
    const kindFilter = segments.length === 1 ? KIND_SLUG_MAP[segments[0]] : undefined;

    if (kindFilter) {
      const data = await buildModelsList(kindFilter);
      return Response.json({ object: "list", data }, { headers: CORS });
    }

    const id = segments.map((s) => decodeURIComponent(s)).join("/");
    const model = await findModel(id);
    if (!model) {
      // OpenAI's own 404 for an unknown model, field for field, so an SDK's
      // NotFoundError carries the same code/param it would from api.openai.com.
      return Response.json(
        {
          error: {
            message: `The model '${id}' does not exist`,
            type: "invalid_request_error",
            param: "model",
            code: "model_not_found",
          },
        },
        { status: 404, headers: CORS }
      );
    }
    return Response.json(model, { headers: CORS });
  } catch (error) {
    console.log("Error fetching model:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
