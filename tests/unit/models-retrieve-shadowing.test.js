import { describe, expect, it, vi } from "vitest";

// A combo may be named after a kind slug (the name regex allows `tts`) and may
// even BE of that kind, so the list -- and the tts kind listing -- advertise a
// bare id "tts". Retrieve must return THAT object, not the kind listing, or a
// listed id is unreachable. The DB is mocked at the repo boundary the real
// handler reads through, so the whole resolve path runs unmocked.
vi.mock("@/lib/localDb", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    getCombos: async () => [
      { name: "tts", models: ["gpu/indextts2"], kind: "tts" },
      { name: "embedding", models: ["gpu/qwen3.5-27b-fp8"], kind: null },
    ],
  };
});

import { GET } from "../../src/app/api/v1/models/[...path]/route.js";
import { buildModelsList } from "../../src/app/api/v1/models/route.js";

const call = (segments) => GET(undefined, { params: Promise.resolve({ path: segments }) });

describe("a listed id spelled like a kind slug still retrieves", () => {
  it("same-kind collision: combo `tts` of kind tts is listed under /v1/models/tts and retrieves as itself", async () => {
    const listed = (await buildModelsList(["tts"])).find((m) => m.id === "tts");
    expect(listed, "premise: the tts kind list advertises the bare id").toBeDefined();
    const res = await call(["tts"]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("model");
    expect(body).toEqual(listed);
  });

  it("cross-kind collision: LLM combo `embedding` beats the embedding kind listing", async () => {
    const res = await call(["embedding"]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("model");
    expect(body.id).toBe("embedding");
    expect(body.owned_by).toBe("combo");
  });

  it("still serves the kind listing for a slug no id shadows", async () => {
    const res = await call(["image"]);
    expect(res.status).toBe(200);
    expect((await res.json()).object).toBe("list");
  });
});
