import { randomBytes } from "node:crypto"
import { parseToolCallsAnyFormat, ToolFenceGate } from "./toml.mjs"

/**
 * Creates an OpenAI-compatible completion ID.
 */
export function newCompletionId() {
  return "chatcmpl-" + randomBytes(12).toString("hex")
}

/**
 * Parses DeepSeek's SSE patch protocol stream.
 *
 * @param {ReadableStream<Uint8Array>} stream - Upstream HTTP response body
 * @param {object} callbacks
 * @param {function(number, number): void} [callbacks.onReady] - (requestId, responseId)
 * @param {function('THINK'|'RESPONSE', string): void} [callbacks.onDelta] - (type, deltaText)
 * @param {function(number): void} [callbacks.onUsage] - (accumulatedTokenUsage)
 * @param {function(): void} [callbacks.onClose]
 */
export async function readDeepSeekSseStream(stream, callbacks) {
  const reader = stream.getReader()
  const decoder = new TextDecoder("utf-8")

  let buffer = ""
  let currentEvent = ""
  let dataLines = []

  let lastPath = ""
  const fragTypes = [] // fragment types in order, so paths can be mapped back to THINK / RESPONSE

  function pushFragment(frag) {
    if (!frag || typeof frag !== "object") return
    fragTypes.push(frag.type)
    lastPath = "response/fragments/-1/content"
    if (frag.content && callbacks.onDelta) {
      callbacks.onDelta(frag.type, String(frag.content))
    }
  }

  function appendText(path, text) {
    if (!text || !callbacks.onDelta || !path.endsWith("/content")) return
    const idx = resolveFragmentIndex(path, fragTypes.length)
    if (idx < 0 || idx >= fragTypes.length) return
    const type = fragTypes[idx]
    if (type === "THINK" || type === "RESPONSE") {
      callbacks.onDelta(type, text)
    }
  }

  function handleUsage(v) {
    const num = Number(v)
    if (!Number.isNaN(num) && callbacks.onUsage) {
      callbacks.onUsage(num)
    }
  }

  function applyPatch(dataText) {
    if (!dataText) return
    let parsed
    try {
      parsed = JSON.parse(dataText)
    } catch {
      return // tolerate frames that aren't JSON
    }
    if (!parsed || typeof parsed !== "object") return

    // Bare patch continuation: {"v": "..."} or the initial {"v": {response: {fragments: [...]}}}
    if (parsed.p === undefined) {
      if (typeof parsed.v === "string") {
        appendText(lastPath, parsed.v)
        return
      }
      if (parsed.v && typeof parsed.v === "object") {
        const frags = parsed.v.response?.fragments
        if (Array.isArray(frags)) {
          for (const f of frags) pushFragment(f)
        }
      }
      return
    }

    const path = String(parsed.p)
    lastPath = path

    if (path === "response/fragments" && parsed.o === "APPEND") {
      if (Array.isArray(parsed.v)) {
        for (const f of parsed.v) pushFragment(f)
      }
    } else if (path === "response" && parsed.o === "BATCH") {
      if (Array.isArray(parsed.v)) {
        for (const sub of parsed.v) {
          if (typeof sub?.p === "string" && sub.p.endsWith("accumulated_token_usage")) {
            handleUsage(sub.v)
          }
        }
      }
    } else if (path === "response/accumulated_token_usage" || path.endsWith("/accumulated_token_usage")) {
      handleUsage(parsed.v)
    } else if (path.endsWith("/content")) {
      if (typeof parsed.v === "string") appendText(path, parsed.v)
    }
  }

  function dispatchFrame() {
    const dataText = dataLines.join("\n")
    const ev = currentEvent
    currentEvent = ""
    dataLines = []

    if (ev === "close") {
      if (callbacks.onClose) callbacks.onClose()
      return true
    }

    if (ev === "ready") {
      try {
        const r = JSON.parse(dataText)
        if (callbacks.onReady && r.response_message_id) {
          callbacks.onReady(r.request_message_id, r.response_message_id)
        }
      } catch {}
      return false
    }

    if (ev === "update_session" || ev === "title" || ev === "") {
      applyPatch(dataText)
    }

    return false
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "")
        if (line === "") {
          if (dispatchFrame()) return
        } else if (line.startsWith(":")) {
          // keep-alive comment
        } else if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""))
        }
      }
    }

    if (dataLines.length > 0 || currentEvent) dispatchFrame()
  } finally {
    reader.releaseLock()
  }
}

function resolveFragmentIndex(path, count) {
  const marker = "response/fragments/"
  const i = path.indexOf(marker)
  if (i < 0) return -1
  const rest = path.slice(i + marker.length)
  const slash = rest.indexOf("/")
  if (slash < 0) return -1
  const seg = rest.slice(0, slash)
  if (seg === "-1") return count - 1
  const k = parseInt(seg, 10)
  return Number.isNaN(k) ? -1 : k
}

/**
 * The usage DeepSeek's stream reports is cumulative for the whole session, so a
 * turn's usage is this turn's total minus the session's previous total. When the
 * upstream sends no usage frame the reply's length stands in for it. This is
 * deepseek2api's buildUsage, kept as it was so the numbers match it.
 */
export function turnUsage({ accumulated, previous, replyChars }) {
  const completion = Math.floor(replyChars / 4)
  // -1 means "no frame yet" or "first turn", so the cumulative total is the turn's
  let span = accumulated >= 0 ? (previous >= 0 ? accumulated - previous : accumulated) : 0
  if (span <= 0) span = completion
  const prompt = Math.max(0, span - completion)
  return {
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: span },
    total: accumulated,
  }
}

/**
 * Creates an OpenAI-compatible SSE ReadableStream that formats chunks from DeepSeek upstream.
 */
export function createOpenAiStreamResponse({
  upstreamStream,
  completionId,
  modelName,
  createdAt,
  previousUsage = -1,
  onSessionReady,
  onFinish,
  streamOptions,
  signal,
  hasTools = false,
  toolFormat = "toml",
}) {
  const encoder = new TextEncoder()
  const accumulated = { value: -1 }
  let hasSentRole = false
  let replyChars = 0
  let reply = ""

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk) => {
        controller.enqueue(encoder.encode(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`))
      }
      const sendDelta = (delta, finishReason = null, usage = null) => {
        const chunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created: createdAt,
          model: modelName,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        }
        if (usage) chunk.usage = usage
        send(chunk)
      }

      const gate = hasTools ? new ToolFenceGate((chunkText) => sendDelta({ ...takeRole(), content: chunkText })) : null

      // The role goes out with the first delta, as OpenAI's own streams do.
      // Gated content can hold text back, so the role rides whichever delta
      // leaves first.
      const takeRole = () => {
        if (hasSentRole) return {}
        hasSentRole = true
        return { role: "assistant" }
      }

      try {
        await readDeepSeekSseStream(upstreamStream, {
          onReady: (reqId, respId) => {
            if (onSessionReady) onSessionReady(reqId, respId)
          },
          onDelta: (type, text) => {
            if (type === "RESPONSE") {
              replyChars += text.length
              reply += text
            }
            if (type === "THINK") {
              sendDelta({ ...takeRole(), reasoning_content: text })
            } else if (hasTools) {
              gate.push(text)
            } else {
              sendDelta({ ...takeRole(), content: text })
            }
          },
          onUsage: (tokens) => {
            accumulated.value = tokens
          },
        })

        if (hasTools && gate) {
          gate.flush()
        }

        const { usage, total } = turnUsage({
          accumulated: accumulated.value,
          previous: previousUsage,
          replyChars,
        })

        if (hasTools) {
          const { toolCalls, cleanText } = parseToolCallsAnyFormat(reply, toolFormat)
          if (toolCalls.length > 0) {
            sendDelta({
              ...takeRole(),
              tool_calls: toolCalls.map((tc, index) => ({
                index,
                id: tc.id,
                type: "function",
                function: tc.function,
              })),
            })
            sendDelta({}, "tool_calls", streamOptions?.include_usage ? usage : null)
            send("[DONE]")
            controller.close()
            // The client keeps what it was actually sent, which for a gated
            // stream is the text the gate let through, not the cleaned text.
            if (onFinish) onFinish(total, reply, toolCalls, gate?.sent ?? cleanText, false)
            return
          }
        }

        sendDelta(takeRole(), "stop", streamOptions?.include_usage ? usage : null)
        send("[DONE]")
        controller.close()
        if (onFinish) onFinish(total, reply, null, reply, false)
      } catch (err) {
        if (signal?.aborted) {
          try {
            controller.close()
          } catch {}
          if (onFinish) onFinish(accumulated.value, reply, null, null, true)
          return
        }
        // Tell the client what went wrong the way OpenAI's own streams do,
        // so a reasoning UI shows the message instead of a bare disconnect.
        try {
          send({ error: { message: err?.message || String(err), type: "api_error" } })
          send("[DONE]")
        } catch {}
        try {
          controller.close()
        } catch {}
        if (onFinish) onFinish(accumulated.value, reply, null, null, true)
      }
    },

    // A client that drops the stream (a stopped agent run) ends the turn too,
    // so the conversation isn't held for it.
    cancel() {
      if (onFinish) onFinish(accumulated.value, reply, null, null, true)
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}

/**
 * Consumes the entire upstream stream and returns an OpenAI-compatible JSON Response.
 */
export async function createOpenAiJsonResponse({
  upstreamStream,
  completionId,
  modelName,
  createdAt,
  previousUsage = -1,
  onSessionReady,
  onFinish,
  hasTools = false,
  toolFormat = "toml",
}) {
  let content = ""
  let reasoningContent = ""
  let accumulated = -1
  let replyChars = 0

  await readDeepSeekSseStream(upstreamStream, {
    onReady: (reqId, respId) => {
      if (onSessionReady) onSessionReady(reqId, respId)
    },
    onDelta: (type, text) => {
      if (type === "THINK") reasoningContent += text
      else {
        content += text
        replyChars += text.length
      }
    },
    onUsage: (tokens) => {
      accumulated = tokens
    },
  })

  const { usage, total } = turnUsage({ accumulated, previous: previousUsage, replyChars })

  let toolCalls = []
  let finishReason = "stop"
  let messageContent = content

  if (hasTools) {
    const parsed = parseToolCallsAnyFormat(content, toolFormat)
    if (parsed.toolCalls.length > 0) {
      toolCalls = parsed.toolCalls
      finishReason = "tool_calls"
      messageContent = parsed.cleanText || null
    }
  }

  if (onFinish) onFinish(total, content, toolCalls.length > 0 ? toolCalls : null, messageContent ?? "", false)

  const message = { role: "assistant", content: messageContent }
  if (reasoningContent) message.reasoning_content = reasoningContent
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  const result = {
    id: completionId,
    object: "chat.completion",
    created: createdAt,
    model: modelName,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  }

  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}
