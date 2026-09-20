import { describe, expect, it, vi } from "vitest";

// A combo may be named after a kind slug (the name regex allows `tts`), and the
// list will then advertise id "tts". Retrieve must still return THAT object,
// not the tts kind listing, or a listed id is unreachable. Mocked catalogue
// because creating a combo needs the dashboard DB.
vi.mock("../../src/app/api/v1/models/route.js", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    buildCatalogue: async () => [
      { id: "tts", object: "model", owned_by: "combo", created: 1700000000 },
      { id: "gpu/qwen3.5-27b-fp8", object: "model", owned_by: "gpu", created: 1700000000 },
    ],
  };
});

import { GET } from "../../src/app/api/v1/models/[...path]/route.js";

const call = (segments) => GET(undefined, { params: Promise.resolve({ path: segments }) });

describe("a listed id spelled like a kind slug still retrieves", () => {
  it("returns the combo, not the kind listing, for /v1/models/tts", async () => {
    const res = await call(["tts"]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "tts", object: "model", owned_by: "combo", created: 1700000000 });
  });

  it("still serves the kind listing for a slug no id shadows", async () => {
    const res = await call(["embedding"]);
    expect(res.status).toBe(200);
    expect((await res.json()).object).toBe("list");
  });
});
