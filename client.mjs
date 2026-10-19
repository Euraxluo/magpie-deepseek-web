import { randomBytes } from "node:crypto"
import { Buffer } from "node:buffer"
import { solvePow, buildPowResponseHeader } from "./pow.mjs"

const DEFAULT_BASE_URL = "https://chat.deepseek.com"
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

function generateDeviceId() {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export class DeepSeekError extends Error {
  constructor(message, status = 500, code = 0) {
    super(message)
    this.name = "DeepSeekError"
    this.status = status
    this.code = code
  }
}

export class DeepSeekClient {
  constructor(token, options = {}) {
    this.token = String(token || "").trim()
    this.baseURL = (options.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.deviceId = options.deviceId || generateDeviceId()
    this.version = options.version || "2.5.0"
    this.locale = options.locale || "zh_CN"
    this.timezoneOffset = options.timezoneOffset ?? -new Date().getTimezoneOffset() * 60
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT
  }

  buildHeaders(extra = {}) {
    const headers = new Headers({
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      accept: "*/*",
      origin: this.baseURL,
      referer: `${this.baseURL}/`,
      "user-agent": this.userAgent,
      "x-client-bundle-id": "com.deepseek.chat",
      "x-client-locale": this.locale,
      "x-client-platform": "web",
      "x-client-timezone-offset": String(this.timezoneOffset),
      "x-client-version": this.version,
      "x-device-id": this.deviceId,
      "x-device-model": "",
    })
    for (const [k, v] of Object.entries(extra)) {
      if (v === null || v === undefined) {
        headers.delete(k)
      } else {
        headers.set(k, v)
      }
    }
    return headers
  }

  async request(path, options = {}) {
    const url = `${this.baseURL}${path}`
    const headers = this.buildHeaders(options.headers)

    const resp = await fetch(url, {
      method: options.method || "POST",
      headers,
      body: options.body !== undefined ? options.body : null,
      signal: options.signal,
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "")
      throw new DeepSeekError(`DeepSeek HTTP error ${resp.status}: ${errText.slice(0, 300)}`, resp.status)
    }

    const json = await resp.json()
    if (json.code !== 0) {
      throw new DeepSeekError(`DeepSeek API error ${json.code}: ${json.msg || "unknown"}`, resp.status, json.code)
    }

    return json.data?.biz_data
  }

  /**
   * Fetches a POW challenge from DeepSeek upstream.
   */
  async createPowChallenge(targetPath = "/api/v0/chat/completion", signal) {
    const data = await this.request("/api/v0/chat/create_pow_challenge", {
      method: "POST",
      body: JSON.stringify({ target_path: targetPath }),
      signal,
    })
    if (!data?.challenge) {
      throw new DeepSeekError("Failed to obtain POW challenge from DeepSeek")
    }
    return data.challenge
  }

  /**
   * Creates a new chat session on DeepSeek.
   */
  async createSession(signal) {
    const data = await this.request("/api/v0/chat_session/create", {
      method: "POST",
      body: JSON.stringify({}),
      signal,
    })
    const sessionId = data?.chat_session?.id
    if (!sessionId) {
      throw new DeepSeekError("DeepSeek returned empty session ID")
    }
    return sessionId
  }

  /**
   * Deletes a chat session on DeepSeek.
   */
  async deleteSession(sessionId, signal) {
    try {
      await this.request("/api/v0/chat_session/delete", {
        method: "POST",
        body: JSON.stringify({ chat_session_id: sessionId }),
        signal,
      })
    } catch {}
  }

  /**
   * Uploads a file (e.g. image) to DeepSeek with its own POW.
   */
  async uploadFile(filename, contentType, dataBuffer, signal) {
    const uploadPath = "/api/v0/file/upload_file"
    const challenge = await this.createPowChallenge(uploadPath, signal)
    const solved = await solvePow(challenge)
    const powHeader = buildPowResponseHeader(solved)

    const boundary = "----DeepSeekFormBoundary" + randomBytes(8).toString("hex")
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
    )
    const post = Buffer.from(`\r\n--${boundary}--\r\n`)
    const bodyBuffer = Buffer.concat([pre, dataBuffer, post])

    const headers = this.buildHeaders({
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "x-ds-pow-response": powHeader,
    })

    const resp = await fetch(`${this.baseURL}${uploadPath}`, {
      method: "POST",
      headers,
      body: bodyBuffer,
      signal,
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "")
      throw new DeepSeekError(`File upload HTTP ${resp.status}: ${errText.slice(0, 300)}`, resp.status)
    }

    const json = await resp.json()
    if (json.code !== 0) {
      throw new DeepSeekError(`File upload API error ${json.code}: ${json.msg}`, resp.status, json.code)
    }

    const file = json.data?.biz_data?.file || json.data?.biz_data
    if (!file?.id) {
      throw new DeepSeekError("Upload response contained no file ID")
    }
    return file
  }

  /**
   * Fetches status of uploaded files.
   */
  async fetchFiles(fileIds, signal) {
    const ids = fileIds.map(encodeURIComponent).join(",")
    const data = await this.request(`/api/v0/file/fetch_files?file_ids=${ids}`, {
      method: "GET",
      signal,
    })
    return data?.files || []
  }

  /**
   * Polls file parsing status until SUCCESS.
   */
  async waitFileReady(fileId, timeoutMs = 25000, signal) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("File wait aborted")
      const files = await this.fetchFiles([fileId], signal)
      if (files.length > 0) {
        const f = files[0]
        if (f.status === "SUCCESS") return f
        if (["FAILED", "CONTENT_FILTER", "CONTENT_TOO_LONG", "CANCELLED"].includes(f.status)) {
          throw new DeepSeekError(`File parsing failed with status: ${f.status}`)
        }
      }
      await new Promise((r) => setTimeout(r, 600))
    }
    throw new DeepSeekError(`File parsing timed out after ${timeoutMs}ms`)
  }

  /**
   * Uploads an image reference (base64 data or URL).
   */
  async uploadImage(imageRef, signal) {
    let buf
    let mime = "image/png"
    let filename = `image_${Date.now()}.png`

    if (imageRef.type === "data") {
      buf = Buffer.from(imageRef.data, imageRef.isBase64 ? "base64" : "utf8")
      if (imageRef.mime) {
        mime = imageRef.mime
        const ext = mime.split("/")[1] || "png"
        filename = `image_${Date.now()}.${ext}`
      }
    } else if (imageRef.type === "url") {
      const res = await fetch(imageRef.url, { signal })
      if (!res.ok) throw new Error(`Failed to fetch image URL: ${imageRef.url}`)
      const arrayBuf = await res.arrayBuffer()
      buf = Buffer.from(arrayBuf)
      const ct = res.headers.get("content-type")
      if (ct) {
        mime = ct.split(";")[0].trim()
        const ext = mime.split("/")[1] || "png"
        filename = `image_${Date.now()}.${ext}`
      }
    }

    const file = await this.uploadFile(filename, mime, buf, signal)
    const ready = await this.waitFileReady(file.id, 25000, signal)
    return ready.id
  }

  /**
   * Starts a streaming completion on DeepSeek.
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {number|null} [input.parentMessageId]
   * @param {string|null} [input.modelType]
   * @param {string} input.prompt
   * @param {string[]} [input.refFileIds]
   * @param {boolean} [input.thinkingEnabled]
   * @param {boolean} [input.searchEnabled]
   * @param {AbortSignal} [signal]
   * @returns {Promise<Response>} Upstream fetch response with SSE body
   */
  async completion(input, signal) {
    const challenge = await this.createPowChallenge("/api/v0/chat/completion", signal)
    const solved = await solvePow(challenge)
    const powHeader = buildPowResponseHeader(solved)

    const payload = {
      chat_session_id: input.sessionId,
      parent_message_id: input.parentMessageId ?? null,
      model_type: input.modelType ?? null,
      prompt: input.prompt,
      ref_file_ids: input.refFileIds || [],
      thinking_enabled: Boolean(input.thinkingEnabled),
      search_enabled: Boolean(input.searchEnabled),
      action: null,
      preempt: false,
    }

    const headers = this.buildHeaders({
      "x-ds-pow-response": powHeader,
    })

    const resp = await fetch(`${this.baseURL}/api/v0/chat/completion`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "")
      throw new DeepSeekError(`DeepSeek completion HTTP ${resp.status}: ${errText.slice(0, 300)}`, resp.status)
    }

    return resp
  }
}
