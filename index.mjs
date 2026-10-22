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
  readDeepSeekSseStream,
} from "./sse.mjs"
import {
  buildAnchorPrompt,
  buildToolsPrompt,
  formatToolCallsToToml,
  formatToolResult,
  parseToolCalls,
  parseToolCallsAnyFormat,
  resolveToolFormat,
  toolPromptsFor,
} from "./toml.mjs"

const convStore = new ConversationStore({ maxSize: 100, ttlMs: 30 * 60 * 1000 })

// Sessions deepseek.com leaves idle past the TTL are deleted upstream so an
// account's session list stays clean. One sweep runs per process; it ends
// when the last request has been idle for the TTL.
let sweeper = null
function keepSweeping() {
  if (sweeper) return
  sweeper = (async () => {
    while (convStore.size > 0) {
      // `unref` so an idle sweep never keeps a short-lived process (a CLI
      // run, a test) alive just because one conversation was registered.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 60 * 1000)
        timer.unref?.()
      })
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
 * the key is the client's history up to its last assistant turn — that is the
 * list the previous request registered after its turn. It is not "every
 * message but the last": a parallel tool round appends one tool result per
 * call, so slicing off only the last one can never match.
 */
async function conversationFor({ messages, modelId, conversationId, client, token, signal }) {
  const usable = (conv) => conv && conv.token === token

  if (conversationId) {
    const bySession = convStore.getBySession(conversationId)
    if (usable(bySession)) return { conv: bySession, fresh: false }
  } else {
    const lastAssistantIdx = findLastAssistantIndex(messages)
    const endings = lastAssistantIdx >= 0 ? [lastAssistantIdx + 1, messages.length - 1] : [messages.length - 1]
    for (const end of endings) {
      const byPrefix = convStore.getByPrefix(calculatePrefixKey(messages.slice(0, end), modelId))
      if (usable(byPrefix)) return { conv: byPrefix, fresh: false }
    }
  }

  const sessionId = await client.createSession(signal)
  return {
    conv: new Conversation({ sessionId, client, token }),
    fresh: true,
  }
}

function findLastAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return i
  }
  return -1
}

/**
 * The last assistant turn that actually said something — prose or a tool call.
 *
 * A client replays an empty stop as an appended assistant turn holding no text
 * and no calls. Splitting the turn at that message would leave nothing between
 * it and the end of the history, so the retry would carry the tools anchor
 * alone: no task, no tool results. The model then restarts from nothing and
 * answers with reasoning only, which is the empty-stop spiral. Anchoring on the
 * last substantive turn keeps the pending tool results in the retry.
 */
function findLastMeaningfulAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "assistant") continue
    const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    if (hasCalls || extractText(m.content).trim()) return i
  }
  return -1
}

function buildTurnPrompt({ messages, tools, toolChoice, parallelToolCalls, fresh, toolFormat = "json" }) {
  const hasTools = Array.isArray(tools) && tools.length > 0 && toolChoice !== "none"
  const prompts = toolPromptsFor(toolFormat, tools, toolChoice)
  const lastAssistantIdx = findLastMeaningfulAssistantIndex(messages)

  // OpenAI's tool results name the call only by id; the name lives on the
  // assistant turn that asked for it. The model needs the name: it is what
  // tells it which step just finished.
  const callNames = new Map()
  for (const m of messages) {
    for (const tc of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
      if (tc?.id && tc?.function?.name) callNames.set(tc.id, tc.function.name)
    }
  }
  const resultLabel = (msg) => msg.name || callNames.get(msg.tool_call_id) || msg.tool_call_id

  const newMessages =
    lastAssistantIdx >= 0
      ? messages.slice(lastAssistantIdx + 1)
      : messages.filter((m) => m?.role !== "system" && m?.role !== "developer")

  const turnParts = []
  const turnImages = []

  for (const msg of newMessages) {
    const role = msg?.role
    if (role === "tool") {
      const text = extractText(msg.content)
      turnParts.push(formatToolResult(resultLabel(msg), text))
    } else if (role === "user") {
      const text = extractText(msg.content)
      if (text) turnParts.push(text)
      const imgs = extractImages(msg.content)
      if (imgs.length > 0) turnImages.push(...imgs)
    }
  }

  let prompt = turnParts.join("\n\n")

  if (fresh) {
    const systemParts = []
    for (const msg of messages) {
      if (msg?.role === "system" || msg?.role === "developer") {
        const text = extractText(msg.content)
        if (text) systemParts.push(text)
      }
    }

    if (hasTools) {
      const toolsPrompt = prompts.build(tools, toolChoice)
      if (toolsPrompt) systemParts.push(toolsPrompt)
    }

    const historyParts = []
    if (lastAssistantIdx >= 0) {
      for (let i = 0; i <= lastAssistantIdx; i++) {
        const m = messages[i]
        const role = m?.role
        if (role === "user") {
          const t = extractText(m.content)
          if (t) historyParts.push(`[User]: ${t}`)
        } else if (role === "assistant") {
          if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            const prefix = extractText(m.content) ? `[Assistant]: ${extractText(m.content)}\n` : "[Assistant]:\n"
            historyParts.push(prefix + prompts.formatCalls(m.tool_calls))
          } else {
            const t = extractText(m.content)
            if (t) historyParts.push(`[Assistant]: ${t}`)
          }
        } else if (role === "tool") {
          historyParts.push(formatToolResult(resultLabel(m), extractText(m.content)))
        }
      }
    }

    const fullParts = []
    if (systemParts.length > 0) {
      fullParts.push(`[System]\n${systemParts.join("\n\n")}\n[/System]`)
    }
    if (historyParts.length > 0) {
      fullParts.push(historyParts.join("\n\n"))
    }
    if (prompt) {
      fullParts.push(prompt)
    }

    prompt = fullParts.join("\n\n")
  }

  // The anchor rides every turn, not just the first: a long agent prompt can
  // bury the tool format, and the last line of the prompt carries the most
  // weight with the web models.
  if (hasTools) {
    const anchor = prompts.anchor(tools, toolChoice, parallelToolCalls)
    if (anchor) prompt = prompt ? `${prompt}\n\n${anchor}` : anchor
  }

  return { prompt, images: turnImages }
}

/**
 * Reads one upstream completion into memory.
 *
 * A turn that comes back empty must be retried before the client sees a stop,
 * so nothing is forwarded live. Reasoning and prose are replayed together once
 * the turn is accepted.
 */
async function readUpstreamTurn(stream) {
  let reply = ""
  let reasoning = ""
  let usage = -1
  let responseId = null
  let hint = null
  await readDeepSeekSseStream(stream, {
    onReady: (_requestId, id) => {
      responseId = id
    },
    onDelta: (type, text) => {
      if (type === "THINK") reasoning += text
      else reply += text
    },
    onUsage: (tokens) => {
      usage = tokens
    },
    onHint: (h) => {
      hint = h
    },
  })
  return { reply, reasoning, usage, responseId, hint }
}

/** True when the model produced prose. A tool fence lives in that prose. */
function turnHasReply(turn) {
  return Boolean(turn?.reply && turn.reply.trim())
}

/**
 * The 429 a hint frame stands for, or null when the turn carries none.
 *
 * DeepSeek throttles a fast sender in-band: the completion answers 200, then
 * closes with `event: hint` and "retry later" instead of a reply. Only a turn
 * with nothing else in it is a throttle; a hint beside real prose is just a
 * notice and must not throw the reply away.
 */
function rateLimitFromHint(turn) {
  if (turn?.hint?.finishReason !== "rate_limit_reached" || turn.reply?.trim()) return null
  return new DeepSeekError(`deepseek rate limited this account: ${turn.hint.content}`, 429)
}

/**
 * Whether a failed turn may be retried on this session or on a new one.
 * An empty turn passes `null`: there is no error, the session itself went quiet.
 * Auth failures, rate limits and a cancelled request must not open sessions.
 */
function canReplaceSession(err, signal) {
  if (signal?.aborted) return false
  if (!err) return true
  if (err.name === "AbortError") return false
  if (err.status === 401 || err.status === 403 || err.status === 429) return false
  if (err.code === 40002 || err.code === 40003) return false
  return true
}

/** Rebuilds a collected turn as the SSE shape the OpenAI adapters already read. */
function replayUpstream(turn) {
  const fragments = []
  if (turn.reasoning) fragments.push({ id: 1, type: "THINK", content: turn.reasoning })
  if (turn.reply) fragments.push({ id: 2, type: "RESPONSE", content: turn.reply })
  const frames = [
    `event: ready\ndata: ${JSON.stringify({ request_message_id: 1, response_message_id: turn.responseId })}\n\n`,
  ]
  if (fragments.length > 0) {
    frames.push(`data: ${JSON.stringify({ v: { response: { fragments } } })}\n\n`)
  }
  if (turn.usage >= 0) {
    frames.push(`data: ${JSON.stringify({ p: "response/accumulated_token_usage", v: turn.usage })}\n\n`)
  }
  frames.push("event: close\ndata: {}\n\n")
  const encoded = new TextEncoder().encode(frames.join(""))
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded)
      controller.close()
    },
  })
}

/**
 * QuotaHub's Gemini web rule, on a DeepSeek web chat.
 *
 * A bad turn is retried once against the same session, branching from the
 * previous node. If that is still bad, the session is dropped and a new
 * DeepSeek chat is opened with the full history. The caller keeps whichever
 * conversation actually answered, so the next turn continues that chat until
 * it fails the same way.
 */
async function resolveSessionTurn({
  conv,
  prompt,
  freshPrompt,
  client,
  token,
  signal,
  completionInput,
}) {
  const attempt = async (target, promptText) => {
    const parentMessageId = target.hasParent ? target.parentMessageId : null
    const upstream = await client.completion(
      {
        ...completionInput,
        sessionId: target.sessionId,
        parentMessageId,
        prompt: promptText,
      },
      signal
    )
    const turn = await readUpstreamTurn(upstream.body)
    // A throttled turn is not an empty one: DeepSeek closed the stream with a
    // hint and no reply. Retrying it at once, on this session or a new chat,
    // is what keeps the throttle going, so it is reported instead.
    const throttled = rateLimitFromHint(turn)
    if (throttled) throw throttled
    // A failed attempt leaves the parent where it was, so the same-session
    // retry branches from the previous node rather than the empty one. The
    // accepted node becomes the parent only after the caller commits it.
    return turnHasReply(turn) ? { ok: true, turn } : { ok: false, turn }
  }

  const fail = async (target, promptText) => {
    try {
      return await attempt(target, promptText)
    } catch (err) {
      // A stream that breaks while being read is a transport failure. The
      // caller reports it; opening another chat would hide the disconnect.
      if (err instanceof DeepSeekError && canReplaceSession(err, signal)) return { ok: false, error: err }
      throw err
    }
  }

  const first = await fail(conv, prompt)
  if (first.ok) return { conv, turn: first.turn, replaced: false }

  const retried = await fail(conv, prompt)
  if (retried.ok) return { conv, turn: retried.turn, replaced: false }

  // The next queued turn is already waiting on this same object. Retarget it
  // in place so that turn follows the new DeepSeek chat instead of sending to
  // a session we are about to drop. The old chat stays until the new one
  // answers: if opening the new one fails, the next request can try again.
  const oldId = conv.sessionId
  const sessionId = await client.createSession(signal)
  console.warn(
    `[deepseek-web] session ${oldId} failed after a same-session retry; opened ${sessionId} and resent history`
  )
  let opened
  try {
    const upstream = await client.completion(
      {
        ...completionInput,
        sessionId,
        parentMessageId: null,
        prompt: freshPrompt,
      },
      signal
    )
    const turn = await readUpstreamTurn(upstream.body)
    const throttled = rateLimitFromHint(turn)
    if (throttled) throw throttled
    opened = turnHasReply(turn) ? { ok: true, turn } : { ok: false, turn }
  } catch (err) {
    await client.deleteSession?.(sessionId, signal)
    if (!(err instanceof DeepSeekError) || !canReplaceSession(err, signal)) throw err
    opened = { ok: false, error: err }
  }
  if (!opened.ok) {
    await client.deleteSession?.(sessionId, signal)
    throw (
      opened.error ??
      new DeepSeekError("deepseek returned an empty assistant turn after opening a new session")
    )
  }
  await client.deleteSession?.(oldId, signal)
  retargetConversation(conv, sessionId)
  return { conv, turn: opened.turn, replaced: true }
}

/** Points a live conversation at a new upstream chat, keeping its queue and prefix keys. */
function retargetConversation(conv, sessionId) {
  const oldId = conv.sessionId
  if (oldId !== sessionId) convStore.bySession.delete(oldId)
  conv.sessionId = sessionId
  conv.parentMessageId = null
  conv.hasParent = false
  conv.turn = 0
  conv.lastUsage = -1
  conv.hasUsage = false
  convStore.bySession.set(sessionId, conv)
}

/**
 * OpenCode and Magpie provider plugin for DeepSeek's web chat
 * (chat.deepseek.com), with the browser's own userToken as the credential.
 */
export async function DeepSeekWebPlugin({ client } = {}, options = {}) {
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
            {
              name: m.name,
              limit: m.limit,
              modalities: m.modalities,
              tool_call: true,
              attachment: m.attachment,
            },
          ])
        ),
      }
    },

    auth: {
      provider: PROVIDER_ID,

      async loader(getAuth, provider) {
        // Tool calls use plaintext JSON in a ```tool_call fence.
        const toolFormat = resolveToolFormat()
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
            const tools = Array.isArray(body.tools) ? body.tools : []
            const toolChoice = body.tool_choice
            const hasTools = tools.length > 0 && toolChoice !== "none"

            // A turn needs something to say: the user's message, or a tool
            // result an agent is handing back. Images alone count too.
            const lastAssistantIdx = findLastAssistantIndex(messages)
            const turnMessages = messages
              .slice(lastAssistantIdx + 1)
              .filter((m) => m?.role !== "system" && m?.role !== "developer")
            const images = turnMessages.flatMap((m) => extractImages(m?.content))
            const hasTurnContent =
              images.length > 0 || turnMessages.some((m) => extractText(m?.content).trim() !== "")
            if (!hasTurnContent) {
              return errorResponse(400, "invalid_request_error", "messages must contain user or tool content")
            }

            try {
              let { conv, fresh } = await conversationFor({
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
              let release = await conv.acquire()
              let startParentMessageId = conv.parentMessageId
              let startHasParent = conv.hasParent
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

                const promptArgs = {
                  messages,
                  tools,
                  toolChoice,
                  parallelToolCalls: body.parallel_tool_calls,
                  toolFormat,
                }
                const { prompt } = buildTurnPrompt({ ...promptArgs, fresh })
                // A replacement session has none of this chat, so it gets the
                // whole history once. Later turns are incremental again.
                const freshPrompt = fresh ? prompt : buildTurnPrompt({ ...promptArgs, fresh: true }).prompt

                const resolved = await resolveSessionTurn({
                  conv,
                  prompt,
                  freshPrompt,
                  client: deepseekClient,
                  token,
                  signal,
                  completionInput: {
                    // The web UI leaves model_type null so DeepSeek selects the
                    // current model for this session. Never derive an upstream
                    // model id from the provider's outer model label.
                    modelType: null,
                    refFileIds,
                    thinkingEnabled: model.thinking,
                    searchEnabled: model.search,
                  },
                })
                if (resolved.replaced) {
                  // The conversation object did not change, so the lock already
                  // held stays the lock. The new chat has no parent yet.
                  startParentMessageId = null
                  startHasParent = false
                }

                const previousUsage = conv.hasUsage ? conv.lastUsage : -1
                const upstreamStream = replayUpstream(resolved.turn)

                const completionId = newCompletionId()
                const createdAt = Math.floor(Date.now() / 1000)

                let latestResponseId = null

                const onSessionReady = (requestId, responseId) => {
                  latestResponseId = responseId
                }

                // Register the continuation key for the next turn even after a
                // partial stream: if the turn aborted or encountered an error,
                // roll back parentMessageId to startParentMessageId so subsequent
                // client retries branch cleanly from the previous node in DeepSeek's tree.
                let finished = false
                const onFinish = (total, reply, toolCalls, shownText, isError = false) => {
                  if (finished) return
                  finished = true

                  if (isError || !latestResponseId) {
                    conv.rollback(startParentMessageId, startHasParent)
                    release()
                    return
                  }

                  conv.commitTurn(latestResponseId)
                  conv.usageBefore(total)
                  // The next request carries this assistant turn back as the
                  // client was shown it — the fence stripped, whatever text
                  // survived the gate — so the registered key is built from
                  // exactly that. The raw reply only stands in where a client
                  // streams by re-reading the whole answer.
                  const shown = toolCalls?.length
                    ? (shownText ?? parseToolCallsAnyFormat(reply, toolFormat).cleanText)
                    : reply
                  const assistantMsg = { role: "assistant", content: shown }
                  if (toolCalls && toolCalls.length > 0) {
                    assistantMsg.tool_calls = toolCalls
                  }
                  const key = calculatePrefixKey(
                    [...messages, assistantMsg],
                    model.id
                  )
                  convStore.register(key, conv)
                  keepSweeping()
                  release()
                }

                const repairToolCall = async (error) => {
                  try {
                    if (!latestResponseId) throw error
                    const repairChoice = toolChoice?.function?.name ? toolChoice : "required"
                    const repairPrompt = toolPromptsFor(toolFormat, tools, repairChoice).build(tools, repairChoice)
                    const repaired = await deepseekClient.completion({
                      sessionId: conv.sessionId,
                      parentMessageId: latestResponseId,
                      modelType: null,
                      prompt: `${error.message}\nNo tools from that response were executed. Re-emit the complete batch using the tool definitions below. Preserve file contents exactly; do not explain or claim success.\n\n${repairPrompt}\n\n${body.parallel_tool_calls === false ? "Emit exactly one tool call; parallel calls are disabled." : "Emit all independent calls in this batch together."}`,
                      refFileIds: [],
                      thinkingEnabled: model.thinking,
                      searchEnabled: model.search,
                    }, signal)
                    latestResponseId = null
                    const createResponse = stream ? createOpenAiStreamResponse : createOpenAiJsonResponse
                    return await createResponse({
                      upstreamStream: repaired.body,
                      completionId,
                      modelName: model.id,
                      createdAt,
                      previousUsage,
                      onSessionReady,
                      onFinish,
                      streamOptions: body.stream_options,
                      signal,
                      hasTools,
                      toolFormat,
                      tools,
                      toolChoice: repairChoice,
                      parallelToolCalls: body.parallel_tool_calls,
                      repairError: error,
                    })
                  } catch (err) {
                    onFinish(-1, "", null, null, true)
                    throw err
                  }
                }

                if (stream) {
                  return createOpenAiStreamResponse({
                    upstreamStream,
                    completionId,
                    modelName: model.id,
                    createdAt,
                    previousUsage,
                    onSessionReady,
                    onFinish,
                    streamOptions: body.stream_options,
                    signal,
                    hasTools,
                    toolFormat,
                    tools,
                    toolChoice,
                    parallelToolCalls: body.parallel_tool_calls,
                    repairToolCall,
                  })
                }
                return await createOpenAiJsonResponse({
                  upstreamStream,
                  completionId,
                  modelName: model.id,
                  createdAt,
                  previousUsage,
                  onSessionReady,
                  onFinish,
                  hasTools,
                  toolFormat,
                  tools,
                  toolChoice,
                  parallelToolCalls: body.parallel_tool_calls,
                  repairToolCall,
                })
              } catch (err) {
                conv.rollback(startParentMessageId, startHasParent)
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
  resolveSessionTurn,
  canReplaceSession,
  turnHasReply,
  mapUpstreamError,
  normalizeUserToken,
  buildTurnPrompt,
  PROVIDER_ID,
  MODELS,
}
