export const PROVIDER_ID = "deepseek-web"
export const PROVIDER_NAME = "DeepSeek Web"

// The web client's models: `thinking_enabled` and `search_enabled` are
// switches on one model, so each combination is a model here. Limits are
// what the web client shows; older turns live in the upstream session.
const MODEL = {
  release_date: "2026-04-01",
  attachment: true,
  tool_call: false,
  limit: { context: 128_000, output: 8_000 },
  modalities: { input: ["text", "image"], output: ["text"] },
}

export const MODELS = {
  "deepseek-chat": {
    name: "DeepSeek-V3 Chat",
    thinking: false,
    search: false,
    ...MODEL,
  },
  "deepseek-reasoner": {
    name: "DeepSeek-R1 Reasoner",
    thinking: true,
    search: false,
    ...MODEL,
  },
  "deepseek-search": {
    name: "DeepSeek-V3 with Web Search",
    thinking: false,
    search: true,
    ...MODEL,
  },
  "deepseek-reasoner-search": {
    name: "DeepSeek-R1 with Web Search",
    thinking: true,
    search: true,
    ...MODEL,
  },
}

// Names clients hardcode for these models; each stands for one of the four.
const ALIASES = {
  "deepseek-v3": "deepseek-chat",
  "deepseek-r1": "deepseek-reasoner",
  "deepseek-thinking": "deepseek-reasoner",
  "deepseek-v3-search": "deepseek-search",
  "deepseek-r1-search": "deepseek-reasoner-search",
}

/**
 * Resolves a requested model id: an id this provider serves, an alias of one,
 * or, for a `deepseek…` name it doesn't know, the served model whose
 * thinking/search switches the name's words name. Anything else is chat.
 */
export function resolveModel(name) {
  const wanted = String(name ?? "").trim()
  const lower = wanted.toLowerCase()

  if (MODELS[lower]) return { id: lower, ...MODELS[lower] }
  if (ALIASES[lower]) return { id: ALIASES[lower], ...MODELS[ALIASES[lower]] }

  if (lower.startsWith("deepseek")) {
    const thinking = /reasoner|think|-r1/.test(lower)
    const search = /search/.test(lower)
    const id = Object.keys(MODELS).find((k) => MODELS[k].thinking === thinking && MODELS[k].search === search)
    if (id) return { id, ...MODELS[id] }
  }

  return { id: "deepseek-chat", ...MODELS["deepseek-chat"] }
}
