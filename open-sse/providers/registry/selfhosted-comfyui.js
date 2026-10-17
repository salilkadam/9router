// Self-hosted ComfyUI image generation over ComfyUI's native API (/prompt,
// /history, /view), with the server address taken from the connection.
//
// The stock `comfyui` entry is a fixed-localhost placeholder that posts a bare
// {prompt}, which ComfyUI rejects. This entry drives real workflow graphs
// (handlers/imageProviders/selfhostedComfyui.js) — Qwen-Image-2512 and
// Z-Image-Turbo — so an on-prem ComfyUI can serve as a combo member, e.g. the
// fallback behind a remote GPU.
//
// authType "apikey" only exists to give the connection a credentials record for
// providerSpecificData.baseUrl; a bare ComfyUI ignores the key (use "none").
export default {
  id: "selfhosted-comfyui",
  priority: 50,
  hasFree: true,
  alias: "selfhosted-comfyui",
  display: {
    name: "Self-hosted ComfyUI",
    icon: "account_tree",
    color: "#4CAF50",
    textIcon: "SC",
    website: "https://github.com/comfyanonymous/ComfyUI",
  },
  category: "apikey",
  auth: {
    apiKey: {
      text: "Set providerSpecificData.baseUrl to the ComfyUI root, e.g. http://comfyui:8188. The key is sent as a Bearer token unless it is \"none\". Optional: providerSpecificData.models.<id>.{unet,clip,vae} to override model file names, providerSpecificData.timeoutMs (default 95000).",
    },
  },
  models: [
    { id: "qwen-image", name: "Qwen-Image 2512 fp8 (ComfyUI)", params: ["n", "size"], kind: "image" },
    { id: "z-image-turbo", name: "Z-Image Turbo (ComfyUI)", params: ["n", "size"], kind: "image" },
  ],
  serviceKinds: ["image"],
  imageConfig: {
    // Overridden per connection; read by the UI only.
    baseUrl: "http://localhost:8188",
    authType: "apikey",
  },
};
