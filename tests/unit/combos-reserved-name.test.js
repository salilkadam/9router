import { describe, expect, it, vi } from "vitest";

// /v1/models/info is a static Next route that wins over the /v1/models/{id}
// catch-all, so a combo named `info` would be listed but never retrievable.
// The only place that can prevent it is combo creation and rename.
vi.mock("@/lib/localDb", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    getComboByName: async () => null,
    getComboById: async () => ({ id: "c1", name: "old", models: [] }),
    createCombo: async (c) => ({ id: "c2", ...c }),
    updateCombo: async (id, body) => ({ id, ...body }),
  };
});

import { POST } from "../../src/app/api/combos/route.js";
import { PUT } from "../../src/app/api/combos/[id]/route.js";

const req = (body) => new Request("http://x/api/combos", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

describe("combo names that would be unretrievable are refused", () => {
  it("POST refuses `info`", async () => {
    const res = await POST(req({ name: "info", models: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reserved/);
  });

  it("PUT refuses renaming to `info`", async () => {
    const res = await PUT(req({ name: "info" }), { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reserved/);
  });

  it("kind slugs are NOT reserved -- the catch-all resolves them", async () => {
    const res = await POST(req({ name: "tts", models: [] }));
    expect(res.status).toBe(201);
  });
});
