// A bare model name must be one of our combos, or it is refused.
//
// A bare name resolves combo -> alias -> inferProviderFromModelName(), and the
// last step GUESSES a provider from the name. On 2026-10-10 the combo
// "qwen3.8-flash-next-think" was deleted; the name was guessed to be OpenAI's
// and the conversation was posted to api.openai.com. DEFAULT_MODEL then
// absorbed every other unknown name into the "auto" combo, whose cloud
// members answered 51 requests. Old names (qwen3.6 / qwen3.5 / gemma-4) were
// answered the same way, so nothing ever told their caller to update.
//
// STRICT_MODEL_NAMES makes the name itself the contract: a combo, or an
// explicit "provider/model", or a 404 that names what does exist.
import { describe, it, expect } from "vitest";
import { strictModelRefusal, isStrictModelNames } from "../../src/sse/services/strictModels.js";

const combos = ["auto", "qwen3.8-flash-next", "qwen3.8-flash-next-think", "qwen3.8-flash-next-batch"];

describe("strict model names", () => {
  it("is off unless asked for", () => {
    expect(isStrictModelNames({})).toBe(false);
    expect(isStrictModelNames({ STRICT_MODEL_NAMES: "false" })).toBe(false);
    expect(isStrictModelNames({ STRICT_MODEL_NAMES: "true" })).toBe(true);
    expect(isStrictModelNames({ STRICT_MODEL_NAMES: "1" })).toBe(true);
  });

  it("lets a combo name through", () => {
    for (const name of combos) {
      expect(strictModelRefusal({ model: name, isCombo: true, comboNames: combos })).toBeNull();
    }
  });

  it("lets an explicit provider/model through, combo or not", () => {
    expect(strictModelRefusal({ model: "gpu/qwen3.8-flash-next", isCombo: false, comboNames: combos })).toBeNull();
    expect(strictModelRefusal({ model: "gemini/gemini-2.5-flash", isCombo: false, comboNames: combos })).toBeNull();
  });

  it("refuses a bare name that is not a combo, and says what exists", () => {
    for (const name of ["qwen3.6-35b-a3b-fp8", "qwen3.5-27b-fp8-think", "gemma-4-e4b-it", "gpt-4o"]) {
      const msg = strictModelRefusal({ model: name, isCombo: false, comboNames: combos });
      expect(msg).toContain(`\`${name}\``);
      expect(msg).toContain("does not exist");
      expect(msg).toContain("qwen3.8-flash-next");
    }
  });

  it("refuses the name that reached OpenAI when its combo went missing", () => {
    const left = ["auto", "qwen3.8-flash-next-batch"];
    expect(strictModelRefusal({ model: "qwen3.8-flash-next-think", isCombo: false, comboNames: left }))
      .toContain("does not exist");
  });
});
