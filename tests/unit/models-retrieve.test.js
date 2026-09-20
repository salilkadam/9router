import { describe, expect, it } from "vitest";

import { buildCatalogue, buildModelsList } from "../../src/app/api/v1/models/route.js";
import { GET, findModel } from "../../src/app/api/v1/models/[...path]/route.js";

const call = (segments) => GET(undefined, { params: Promise.resolve({ path: segments }) });

// OpenAI's contract: every id models.list() returns, models.retrieve() can
// fetch, and the two answer with the same object. Behind a gateway that fronted
// list and retrieve with DIFFERENT services, half the listed ids 404'd on
// retrieve. Both now resolve from buildCatalogue, and this pins that.
describe("GET /v1/models/{id} agrees with GET /v1/models", () => {
  it("retrieves every listed id and returns the same object", async () => {
    const listed = await buildCatalogue();
    expect(listed.length).toBeGreaterThan(0);
    for (const m of listed) {
      const res = await call(m.id.split("/"));
      expect(res.status, m.id).toBe(200);
      expect(await res.json()).toEqual(m);
    }
  });

  it("finds models advertised only under a per-kind listing", async () => {
    const kinds = await buildModelsList(["tts", "stt", "embedding", "image"]);
    for (const m of kinds) {
      expect(await findModel(m.id), m.id).toEqual(m);
    }
  });

  it("matches exactly -- a bare suffix does not alias a prefixed id", async () => {
    const prefixed = (await buildCatalogue()).find((m) => m.id.includes("/"));
    if (!prefixed) return;
    const suffix = prefixed.id.slice(prefixed.id.indexOf("/") + 1);
    const catalogue = await buildCatalogue();
    if (catalogue.some((m) => m.id === suffix)) return; // legitimately listed on its own
    expect(await findModel(suffix)).toBeNull();
  });

  it("answers an unknown id with OpenAI's model_not_found body", async () => {
    const res = await call(["no-such-model-8f2c"]);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {
        message: "The model 'no-such-model-8f2c' does not exist",
        type: "invalid_request_error",
        param: "model",
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
