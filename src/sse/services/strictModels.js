// STRICT_MODEL_NAMES: a bare model name must be one of this router's combos.
//
// Without it a bare name that is not a combo is GUESSED to belong to a
// provider (inferProviderFromModelName), and DEFAULT_MODEL absorbs whatever
// is left into a catch-all combo. Both answer a request under a name that
// does not exist here, and both can send it to a provider the caller never
// asked for: on 2026-10-10 a deleted combo's name was guessed to be OpenAI's
// and the conversation went to api.openai.com, and "auto"'s cloud members
// answered the rest.
//
// With it, a bare name is a combo or a 404 (model_not_found) naming what
// exists. An explicit "provider/model" is unaffected: asking for a provider
// by name is the caller's own decision.

export function isStrictModelNames(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.STRICT_MODEL_NAMES || ""));
}

/**
 * @returns {string|null} the refusal message, or null if the name may proceed
 */
export function strictModelRefusal({ model, isCombo, comboNames = [] }) {
  if (isCombo || model.includes("/")) return null;
  const known = [...comboNames].sort().join(", ") || "none";
  return `The model \`${model}\` does not exist. Available: ${known}.`;
}
