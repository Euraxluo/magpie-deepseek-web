import { Buffer } from "node:buffer"
import { DeepSeekClient, DeepSeekError } from "./client.mjs"
import { MODELS, PROVIDER_ID, PROVIDER_NAME, resolveModel } from "./models.mjs"
import { normalizeUserToken, validateToken } from "./auth.mjs"
import {
  Conversation,
  ConversationStore,
  calculatePrefixKey,
  extractImages,
  extractText,
} from "./conv.mjs"
import {
  createOpenAiJsonResponse,
  createOpenAiStreamResponse,
  newCompletionId,
} from "./sse.mjs"

const convStore = new ConversationStore({ maxSize: 100, ttlMs: 30 * 60 * 1000 })

// Sessions deepseek.com leaves idle past the TTL are deleted upstream so an
// account's session list stays clean. One sweep runs per process; it ends
// when the last request has been idle for the TTL.
let sweeper = null
function keepSweeping() {
  if (sweeper) return
  sweeper = (async () => {
    while (convStore.size > 0) {
      await new Promise((r) => setTimeout(r, 60 * 1000))
      await convStore.sweep().catch(() => {})
    }
    sweeper = null
  })()
}

/** OpenAI's error body, so clients show a message rather than a bare status. */
function errorResponse(status, type, message) {
  return new Response(JSON.stringify({ error: { message, type, code: null } }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

function mapUpstreamError(err) {
  const ae = err instanceof DeepSeekError ? err : null
  if (!ae) return { status: 502, message: `deepseek upstream error: ${err?.message ?? String(err)}` }
  // DeepSeek answers a bad sign-in with its own envelope codes, not 401
  const rejected = ae.status === 401 || ae.status === 403 || ae.code === 40002 || ae.code === 40003
  if (rejected) {
    return { status: 401, message: "deepseek rejected the user token (invalid or expired); sign in again" }
  }
  if (ae.status === 429) {
    return { status: 429, message: "deepseek rate limited this account; retry later" }
  }
  return { status: 502, message: `deepseek upstream error: ${ae.message}` }
}

async function readJsonBody(input, init) {
  try {
    if (typeof init?.body === "string") return JSON.parse(init.body)
    if (init?.body && Buffer.isBuffer(init.body)) return JSON.parse(init.body.toString("utf8"))
    if (init?.body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(init.body))
    if (typeof input === "object" && typeof input?.clone === "function") return await input.clone().json()
  } catch {}
  return null
}

/**
 * Picks or opens the DeepSeek session a request continues.
 *
 * `body.conversation_id`, if given, names an upstream session outright. Else
 * the key is every message but the last: a client that appends one exchange
 * per request then hits the session the previous turn registered under the
 * messages as they stood after that turn.
 */
async function conversationFor({ messages, modelId, conversationId, client, token, signal }) {
  const usable = (conv) => conv && conv.token === token

  if (conversationId) {
    const bySession = convStore.getBySession(conversationId)
    if (usable(bySession)) return { conv: bySession, fresh: false }
  } else {
    const key = calculatePrefixKey(messages.slice(0, -1), modelId)
    const byPrefix = convStore.getByPrefix(key)
    if (usable(byPrefix)) return { conv: byPrefix, fresh: false }
  }

  const sessionId = await client.createSession(signal)
  return {
    conv: new Conversation({ sessionId, client, token }),
    fresh: true,
  }
}

/**
 * OpenCode and Magpie provider plugin for DeepSeek's web chat
 * (chat.deepseek.com), with the browser's own userToken as the credential.
 */
export async function DeepSeekWebPlugin({ client } = {}) {
  return {
    // Models the provider serves. models.dev does not list this provider, so
    // it is declared here; the npm package names the wire protocol.
    config(config) {
      config.provider = config.provider ?? {}
      config.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: "https://chat.deepseek.com/v1",
        models: Object.fromEntries(
          Object.entries(MODELS).map(([id, m]) => [
            id,
            { name: m.name, limit: m.limit, modalities: m.modalities },
          ])
        ),
      }
    },

    auth: {
      provider: PROVIDER_ID,

      async loader(getAuth) {
        const auth = await getAuth()
        const token = normalizeUserToken(auth?.access ?? auth?.key)
        if (!token) return {}

        const deepseekClient = new DeepSeekClient(token)

        return {
          baseURL: "https://chat.deepseek.com/v1",
          apiKey: token,

          async fetch(input, init) {
            const url = typeof input === "string" ? input : input?.url ?? ""
            const method = (init?.method ?? (typeof input === "object" ? input?.method : null) ?? "GET").toUpperCase()
            const signal = init?.signal ?? (typeof input === "object" && input ? input.signal : undefined)

            // GET /v1/models: the list is fixed, no upstream call needed
            if (method === "GET" && new URL(url, "https://chat.deepseek.com").pathname.endsWith("/models")) {
              const created = Math.floor(Date.now() / 1000)
              return new Response(
                JSON.stringify({
                  object: "list",
                  data: Object.keys(MODELS).map((id) => ({
                    id,
                    object: "model",
                    created,
                    owned_by: "deepseek",
                  })),
                }),
                { headers: { "Content-Type": "application/json; charset=utf-8" } }
              )
            }

            const path = (() => {
              try {
                return new URL(url, "https://chat.deepseek.com").pathname
              } catch {
                return ""
              }
            })()
            if (method !== "POST" || !path.endsWith("/chat/completions")) {
              return errorResponse(404, "not_found_error", `deepseek-web does not serve ${method} ${path}`)
            }

            const body = await readJsonBody(input, init)
            if (!body || !Array.isArray(body.messages)) {
              return errorResponse(400, "invalid_request_error", "messages must be an array")
            }

            const model = resolveModel(body.model)
            const messages = body.messages
            const stream = Boolean(body.stream)

            // The web client takes one prompt per turn: the last user message.
            // What came before lives in the upstream session, or in the system
            // block a fresh session is opened with.
            const systemParts = []
            let prompt = ""
            let images = []
            for (const msg of messages) {
              if (msg?.role === "system" || msg?.role === "developer") {
                const text = extractText(msg.content)
                if (text) systemParts.push(text)
              } else if (msg?.role === "user") {
                prompt = extractText(msg.content)
                images = extractImages(msg.content)
              }
            }
            if (!prompt.trim() && images.length === 0) {
              return errorResponse(400, "invalid_request_error", "messages must contain a user message with text or images")
            }

            try {
              const { conv, fresh } = await conversationFor({
                messages,
                modelId: model.id,
                conversationId: body.conversation_id,
                client: deepseekClient,
                token,
                signal,
              })

              // A different account signed in since: this session isn't mine.
              if (conv.token !== token) {
                convStore.remove(conv.sessionId, conv)
                return errorResponse(401, "authentication_error", "this conversation belongs to another DeepSeek account")
              }

              // A streamed turn holds the conversation until its stream ends,
              // so two turns never interleave; `release` is called by onFinish
              // or when the turn itself fails before a stream exists.
              const release = await conv.acquire()
              try {
                // Images ride as uploaded files; only this turn's are sent,
                // older ones are already in the session's context. Uploading
                // under the held turn keeps the parent id it carries current.
                const refFileIds = []
                if (images.length > 0) {
                  for (const image of images.slice(0, 8)) {
                    refFileIds.push(await deepseekClient.uploadImage(image, signal))
                  }
                }

                if (fresh && systemParts.length > 0) {
                  prompt = `[System]\n${systemParts.join("\n\n")}\n[/System]\n\n${prompt}`
                }

                const previousUsage = conv.hasUsage ? conv.lastUsage : -1

                const upstream = await deepseekClient.completion(
                  {
                    sessionId: conv.sessionId,
                    parentMessageId: conv.hasParent ? conv.parentMessageId : null,
                    modelType: conv.hasParent ? null : "default",
                    prompt,
                    refFileIds,
                    thinkingEnabled: model.thinking,
                    searchEnabled: model.search,
                  },
                  signal
                )

                const completionId = newCompletionId()
                const createdAt = Math.floor(Date.now() / 1000)

                const onSessionReady = (requestId, responseId) => {
                  conv.parentMessageId = responseId
                  conv.hasParent = true
                  conv.turn++
                }

                // Register the continuation key for the next turn even after a
                // partial stream: `ready` already advanced the parent id, so a
                // follow-up can chain from here.
                let finished = false
                const onFinish = (total, reply) => {
                  if (finished) return
                  finished = true
                  conv.usageBefore(total)
                  const key = calculatePrefixKey(
                    [...messages, { role: "assistant", content: reply }],
                    model.id
                  )
                  convStore.register(key, conv)
                  keepSweeping()
                  release()
                }

                if (stream) {
                  return createOpenAiStreamResponse({
                    upstreamStream: upstream.body,
                    completionId,
                    modelName: model.id,
                    createdAt,
                    previousUsage,
                    onSessionReady,
                    onFinish,
                    streamOptions: body.stream_options,
                    signal,
                  })
                }
                return createOpenAiJsonResponse({
                  upstreamStream: upstream.body,
                  completionId,
                  modelName: model.id,
                  createdAt,
                  previousUsage,
                  onSessionReady,
                  onFinish,
                })
              } catch (err) {
                release()
                throw err
              }
            } catch (err) {
              if (signal?.aborted) return errorResponse(499, "api_error", "request cancelled")
              const mapped = mapUpstreamError(err)
              return errorResponse(mapped.status, "api_error", mapped.message)
            }
          },
        }
      },

      methods: [
        {
          type: "oauth",
          label: "DeepSeek 网页账号（粘贴 userToken）",
          authorize: async () => ({
            url: "https://chat.deepseek.com",
            instructions:
              "1. 在打开的页面登录 chat.deepseek.com；\n" +
              "2. F12 → Application → Local Storage → https://chat.deepseek.com；\n" +
              "3. 复制 userToken 的 Value，粘贴到下方（`eyJ…` 原文或 `{\"value\":\"…\"}` 均可）：",
            method: "code",
            callback: async (input) => {
              const token = normalizeUserToken(input)
              if (!token) {
                return { type: "failed", error: "没有从粘贴的内容里找到 userToken" }
              }
              const check = await validateToken(token)
              if (!check.ok) {
                return { type: "failed", error: `DeepSeek 拒绝了该 userToken：${check.error}` }
              }
              return {
                type: "success",
                access: token,
                accountId: check.email || check.userId || "deepseek-user",
              }
            },
          }),
        },
        {
          type: "api",
          label: "DeepSeek userToken（chat.deepseek.com 的 localStorage.userToken）",
        },
      ],
    },
  }
}

export default DeepSeekWebPlugin

// for tests
export const _internal = {
  convStore,
  conversationFor,
  mapUpstreamError,
  normalizeUserToken,
  PROVIDER_ID,
  MODELS,
}
