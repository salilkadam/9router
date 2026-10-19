import { describe, expect, it } from "vitest";

import { buildModelsList } from "../../src/app/api/v1/models/route.js";

// OpenAI's Model object is {id, created, object, owned_by}, and openai-python
// types `created` as a required int. One entry without it raises a pydantic
// ValidationError that fails the WHOLE client.models.list() call, so this is not
// a cosmetic field -- it is the difference between a usable catalogue and none.
describe("/v1/models entries satisfy the OpenAI Model schema", () => {
  it("stamps created on every entry", async () => {
    const models = await buildModelsList(["llm"]);
    expect(models.length).toBeGreaterThan(0);

    const missing = models.filter((m) => typeof m.created !== "number");
    expect(missing.map((m) => m.id)).toEqual([]);
  });

  it("gives every entry the four required fields", async () => {
    const models = await buildModelsList(["llm"]);
    for (const m of models) {
      expect(typeof m.id).toBe("string");
      expect(m.object).toBe("model");
      expect(typeof m.owned_by).toBe("string");
      expect(Number.isInteger(m.created)).toBe(true);
    }
  });

  it("holds for the per-kind listings too", async () => {
    for (const kind of ["tts", "stt", "embedding", "image"]) {
      for (const m of await buildModelsList([kind])) {
        expect(Number.isInteger(m.created), `${kind}/${m.id}`).toBe(true);
      }
    }
  });

  // A fixed epoch, not Date.now(): a catalogue that differs on every call
  // defeats caching and makes two listings impossible to diff.
  it("is stable across calls", async () => {
    const a = await buildModelsList(["llm"]);
    const b = await buildModelsList(["llm"]);
    expect(a.map((m) => m.created)).toEqual(b.map((m) => m.created));
  });
});
