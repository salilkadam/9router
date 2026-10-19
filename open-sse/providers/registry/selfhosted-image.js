// Self-hosted, OpenAI-shaped image generation (e.g. the Bionic GPU API v2 on a
// dedicated A100) — the image counterpart of selfhosted-tts/-stt/-embedding.
//
// Every image provider in this registry carries a FIXED imageConfig.baseUrl, and
// the openai image adapter reads it from there, never from the connection, so
// there was no way to point /v1/images/generations at a server of our own.
// `authType: "apikey"` gives the connection a credentials record, which is where
// providerSpecificData.baseUrl (and optional headers / timeoutMs) live.
//
// The adapter (handlers/imageProviders/selfhostedImage.js) also follows the
// upstream's 202 + job reply, and cancels a job that outlives timeoutMs so a
// combo can fall through to its next member.
export default {
  id: "selfhosted-image",
  priority: 50,
  hasFree: true,
  alias: "selfhosted-image",
  display: {
    name: "Self-hosted Image",
    icon: "image",
    color: "#ffffffff",
    textIcon: "SI",
    website: "https://github.com/comfyanonymous/ComfyUI",
  },
  category: "apikey",
  auth: {
    apiKey: {
      text: "Set providerSpecificData.baseUrl to the API base, e.g. https://host/v2 — /images/generations is appended. Optional: providerSpecificData.headers (extra request headers), providerSpecificData.timeoutMs (job wait budget, default 75000).",
    },
  },
  // The model id is passed straight through, so these are the ids the Bionic v2
  // API accepts; another server simply takes whatever ids it serves.
  models: [
    { id: "qwen-image-2.1", name: "Qwen-Image 2.1 (self-hosted)", params: ["n", "size"], kind: "image" },
    { id: "qwen-image-2.1-turbo", name: "Qwen-Image 2.1 Turbo (self-hosted)", params: ["n", "size"], kind: "image" },
  ],
  serviceKinds: ["image"],
  imageConfig: {
    // Overridden per connection; read by the UI only.
    baseUrl: "http://localhost:8000/v1/images/generations",
    authType: "apikey",
  },
};
