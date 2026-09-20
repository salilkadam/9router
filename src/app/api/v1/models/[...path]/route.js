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
 * Both /v1/models and this route resolve from buildCatalogue, so an id the
 * list returns is one retrieve can find. That holds even when the id is
 * spelled like a kind slug: combo names pass /^[a-zA-Z0-9_.\-]+$/, so an
 * admin can create a combo called `tts`, and the list will advertise it.
 * An exact catalogue match therefore wins over the kind listing --
 * OpenAI's contract outranks a dashboard convenience.
 *
 * Segments arrive already percent-decoded (Next's route matcher decodes each
 * catch-all entry), so they are joined as-is; decoding again turned a listed
 * id containing a literal "%" into a 500.
 */
export async function GET(_request, { params }) {
  try {
    const { path } = await params;
    const segments = Array.isArray(path) ? path : [path];
    const id = segments.join("/");

    const kindFilter = segments.length === 1 ? KIND_SLUG_MAP[segments[0]] : undefined;
    if (kindFilter) {
      // Per-kind entries are always `alias/model`, so a bare slug can only
      // collide with the LLM catalogue (combo names, upstream ids). One pass.
      const shadowing = (await buildCatalogue()).find((m) => m.id === id);
      if (shadowing) return Response.json(shadowing, { headers: CORS });
      const data = await buildModelsList(kindFilter);
      return Response.json({ object: "list", data }, { headers: CORS });
    }

    const model = await findModel(id);
    if (model) return Response.json(model, { headers: CORS });

    // OpenAI's own body for an unknown model: message, type, param null and
    // code model_not_found, so an SDK's NotFoundError carries what it would
    // from api.openai.com. param is null because no request field is at
    // fault -- the same shape the gateway's post-function emits for 404s.
    return Response.json(
      {
        error: {
          message: `The model \`${id}\` does not exist or you do not have access to it.`,
          type: "invalid_request_error",
          param: null,
          code: "model_not_found",
        },
      },
      { status: 404, headers: CORS }
    );
  } catch (error) {
    console.log("Error fetching model:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
