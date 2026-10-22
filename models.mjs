export const PROVIDER_ID = "deepseek-web"
export const PROVIDER_NAME = "DeepSeek Web"

// DeepSeek Web's browser endpoint selects the current model from the web
// session when `model_type` is null. Keep one provider model so an outer model
// id cannot accidentally select an old or unsupported upstream model.
const MODEL = {
  release_date: "2026-04-01",
  attachment: true,
  // The web client has no protocol-level tool calling; the plugin asks the
  // model for JSON ```tool_call blocks and parses them out of the text.
  tool_call: true,
  thinking: false,
  search: false,
  limit: { context: 128_000, output: 8_000 },
  modalities: { input: ["text", "image"], output: ["text"] },
}

export const MODELS = {
  "deepseek-web": {
    name: "DeepSeek Web",
    ...MODEL,
  },
}

/**
 * Resolves every requested provider model to the single web-session model.
 * The resolved id is only the outer provider label; upstream receives null.
 */
export function resolveModel() {
  return { id: "deepseek-web", ...MODELS["deepseek-web"] }
}
