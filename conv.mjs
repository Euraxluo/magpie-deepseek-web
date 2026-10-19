import { createHash } from "node:crypto"

/**
 * Extracts normalized text and image fingerprints from a message content.
 * A long base64 image is hashed rather than kept, so keys stay compact.
 */
export function contentFingerprint(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      if (part.type === "text" && typeof part.text === "string") return part.text
      if (part.type === "image_url") {
        const url = part.image_url?.url || ""
        if (url.startsWith("data:")) {
          return "[image:" + createHash("sha256").update(url).digest("hex").slice(0, 16) + "]"
        }
        return `[image:${url}]`
      }
      return ""
    })
    .join("\n")
}

/**
 * Extracts plain text from message content.
 */
export function extractText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
  }
  return ""
}

/**
 * Extracts image references from message content.
 * Returns array of { type: "data", data, mime, isBase64 } or { type: "url", url }
 */
export function extractImages(content) {
  if (!Array.isArray(content)) return []
  const images = []
  for (const part of content) {
    if (part && part.type === "image_url" && part.image_url?.url) {
      const url = part.image_url.url
      if (url.startsWith("data:")) {
        const comma = url.indexOf(",")
        if (comma > 0) {
          const header = url.slice(5, comma)
          const isBase64 = header.endsWith(";base64")
          const mime = isBase64 ? header.slice(0, -7) : header
          images.push({ type: "data", data: url.slice(comma + 1), mime: mime || "image/png", isBase64 })
        }
      } else {
        images.push({ type: "url", url })
      }
    }
  }
  return images
}

/**
 * The cache key for "messages except the last one", so a client that appends
 * one exchange per request keeps hitting the same DeepSeek session. The model
 * is part of the key, as DeepSeek keeps one model per session.
 *
 * Tool calls are fingerprinted by name and arguments alone: a client sends the
 * calls back in whatever shape its SDK uses, and id/type orderings differ
 * between them, but the pair is what the upstream session actually saw.
 */
export function calculatePrefixKey(messages, modelName) {
  const hash = createHash("sha256")
  for (const m of messages || []) {
    hash.update(String(m?.role ?? ""))
    hash.update("\x1f")
    hash.update(contentFingerprint(m?.content))
    if (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0) {
      hash.update("\x1c")
      for (const tc of m.tool_calls) {
        const fn = tc?.function ?? tc ?? {}
        hash.update(String(fn.name ?? ""))
        hash.update("\x1d")
        hash.update(normalizeArguments(fn.arguments))
        hash.update("\x1d")
      }
    }
    if (m?.tool_call_id) {
      hash.update("\x1b")
      hash.update(String(m.tool_call_id))
    }
    hash.update("\x1e")
  }
  hash.update("\x00")
  hash.update(String(modelName || ""))
  return hash.digest("hex").slice(0, 32)
}

/** Stable text for an arguments value: objects are key-sorted, JSON stays JSON. */
function normalizeArguments(args) {
  if (typeof args === "string") {
    try {
      return JSON.stringify(sortKeys(JSON.parse(args)))
    } catch {
      return args
    }
  }
  return JSON.stringify(sortKeys(args ?? null))
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!value || typeof value !== "object") return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
  return out
}

/**
 * One live DeepSeek session plus what continuing it needs: the last assistant
 * message id, the session-cumulative usage, and a promise chain so one
 * conversation's turns don't interleave.
 */
export class Conversation {
  constructor({ sessionId, client, token }) {
    this.sessionId = sessionId
    this.client = client
    this.token = token
    this.parentMessageId = null
    this.hasParent = false
    this.turn = 0
    this.lastUsage = -1
    this.hasUsage = false
    this.lastUsed = Date.now()
    this.queue = Promise.resolve()
  }

  /** Runs `fn` after the turns already queued for this conversation. */
  async run(fn) {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * Waits for the turns queued ahead and returns the function that lets the
   * next one start. A streamed turn holds it until its stream ends, so two
   * turns of one conversation never interleave upstream.
   */
  acquire() {
    const previous = this.queue
    let release
    this.queue = new Promise((r) => (release = r))
    let released = false
    return previous.then(() => () => {
      if (released) return
      released = true
      this.lastUsed = Date.now()
      release()
    })
  }

  /** Records a turn's cumulative usage; returns what the previous turn left. */
  usageBefore(total) {
    const previous = this.hasUsage ? this.lastUsage : -1
    if (total >= 0) {
      this.lastUsage = total
      this.hasUsage = true
    }
    return previous
  }
}

/**
 * Maps prefix keys and session ids to conversations, evicting the least
 * recently used beyond `maxSize` and the idle beyond `ttlMs`.
 */
export class ConversationStore {
  constructor({ maxSize = 100, ttlMs = 30 * 60 * 1000 } = {}) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
    this.byPrefix = new Map()
    this.bySession = new Map()
  }

  getByPrefix(key) {
    const conv = this.byPrefix.get(key)
    if (conv) conv.lastUsed = Date.now()
    return conv
  }

  getBySession(sessionId) {
    const conv = this.bySession.get(sessionId)
    if (conv) conv.lastUsed = Date.now()
    return conv
  }

  /** Stores a conversation under a derived prefix key; the session mapping is always kept. */
  register(prefixKey, conv) {
    conv.lastUsed = Date.now()
    this.bySession.set(conv.sessionId, conv)
    if (prefixKey) this.byPrefix.set(prefixKey, conv)

    while (this.bySession.size > this.maxSize) {
      let oldestId = null
      let oldest = null
      for (const [id, c] of this.bySession) {
        if (!oldest || c.lastUsed < oldest.lastUsed) {
          oldest = c
          oldestId = id
        }
      }
      if (!oldestId) break
      this.remove(oldestId, oldest)
    }
  }

  remove(sessionId, conv) {
    this.bySession.delete(sessionId)
    for (const [k, v] of this.byPrefix) {
      if (v === conv) this.byPrefix.delete(k)
    }
  }

  /**
   * Drops idle conversations and deletes their upstream sessions, one at a
   * time: DeepSeek rate-limits bursts of session operations.
   */
  async sweep() {
    const now = Date.now()
    const expired = []
    for (const [id, conv] of this.bySession) {
      if (now - conv.lastUsed >= this.ttlMs) {
        expired.push(conv)
        this.remove(id, conv)
      }
    }
    for (const conv of expired) {
      if (!conv.client) continue
      try {
        await conv.client.deleteSession(conv.sessionId)
      } catch {}
      await new Promise((r) => setTimeout(r, 1500))
    }
    return expired.length
  }

  get size() {
    return this.bySession.size
  }
}
