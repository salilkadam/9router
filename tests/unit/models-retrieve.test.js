import { describe, expect, it } from "vitest";

import { buildCatalogue, buildModelsList } from "../../src/app/api/v1/models/route.js";
import { GET } from "../../src/app/api/v1/models/[...path]/route.js";

const call = (segments) => GET(undefined, { params: Promise.resolve({ path: segments }) });

// OpenAI's contract: every id models.list() returns, models.retrieve() can
// fetch, and the two answer with the same object. Behind a gateway that fronted
// list and retrieve with DIFFERENT services, half the listed ids 404'd on
// retrieve. Both now resolve from buildCatalogue, and this pins that.
// These two walk the WHOLE catalogue (~820 ids since v0.5.104 lists the no-auth
// free providers), and each retrieve rebuilds it (~80ms, same cost as upstream's
// own buildModelsList), so they need more than vitest's 5s default.
const EXHAUSTIVE_TIMEOUT_MS = 180_000;

describe("GET /v1/models/{id} agrees with GET /v1/models", () => {
  it("retrieves every listed id and returns the same object", async () => {
    const listed = await buildCatalogue();
    expect(listed.length).toBeGreaterThan(0);
    for (const m of listed) {
      const res = await call(m.id.split("/"));
      expect(res.status, m.id).toBe(200);
      expect(await res.json()).toEqual(m);
    }
  }, EXHAUSTIVE_TIMEOUT_MS);

  it("retrieves models advertised only under a per-kind listing, through GET", async () => {
    const kinds = await buildModelsList(["tts", "stt", "embedding", "image"]);
    expect(kinds.length).toBeGreaterThan(0);
    for (const m of kinds) {
      const res = await call(m.id.split("/"));
      expect(res.status, m.id).toBe(200);
      expect(await res.json()).toEqual(m);
    }
  }, EXHAUSTIVE_TIMEOUT_MS);

  // Next's route matcher hands the handler already-decoded segments. A second
  // decodeURIComponent turned any id holding a literal "%" (custom-model ids
  // are not character-validated) into "URI malformed" -> 500.
  it("does not 500 on an id containing a literal percent sign", async () => {
    const res = await call(["50%off"]);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("model_not_found");
  });

  it("matches exactly -- a bare suffix does not alias a prefixed id", async () => {
    const prefixed = (await buildCatalogue()).find((m) => m.id.includes("/"));
    if (!prefixed) return;
    const suffix = prefixed.id.slice(prefixed.id.indexOf("/") + 1);
    const catalogue = await buildCatalogue();
    if (catalogue.some((m) => m.id === suffix)) return; // legitimately listed on its own
    expect((await call(suffix.split("/"))).status).toBe(404);
  });

  it("answers an unknown id with OpenAI's model_not_found body", async () => {
    const res = await call(["no-such-model-8f2c"]);
    expect(res.status).toBe(404);
    // OpenAI's body, including param null: no request field is at fault, and
    // the gateway's own 404 post-function uses null for the same reason.
    expect(await res.json()).toEqual({
      error: {
        message: "The model `no-such-model-8f2c` does not exist or you do not have access to it.",
        type: "invalid_request_error",
        param: null,
        code: "model_not_found",
      },
    });
  });

  it("still serves the per-kind listings on their single-segment slugs", async () => {
    for (const kind of ["tts", "embedding", "image"]) {
      const res = await call([kind]);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.object).toBe("list");
      expect(body.data).toEqual(await buildModelsList([kind]));
    }
  });

  it("returns a Model object with the four required fields", async () => {
    const [first] = await buildCatalogue();
    const body = await (await call(first.id.split("/"))).json();
    expect(typeof body.id).toBe("string");
    expect(body.object).toBe("model");
    expect(typeof body.owned_by).toBe("string");
    expect(Number.isInteger(body.created)).toBe(true);
  });
});
