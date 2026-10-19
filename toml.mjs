import { randomBytes } from "node:crypto"

/**
 * Parses a TOML string into a JavaScript object.
 * Uses Bun.TOML.parse when running in Bun, with a robust pure-JS fallback
 * for Node.js or environments where Bun is not available.
 */
export function parseToml(src) {
  if (typeof Bun !== "undefined" && Bun?.TOML?.parse) {
    try {
      return Bun.TOML.parse(src)
    } catch {
      // Fall through to JS parser if Bun.TOML is strict or throws
    }
  }
  return parseTomlFallback(src)
}

/**
 * Pure JavaScript TOML parser fallback supporting the TOML subset used by LLMs:
 * - Key-value pairs: bare keys, quoted keys
 * - String types: basic ("..."), multiline basic ("""..."""), literal ('...'), multiline literal ('''...''')
 * - Booleans, integers, floats
 * - Inline arrays and multiline arrays
 * - Inline tables { a = 1, b = 2 }
 * - Section headers: [table], [table.sub], [[array_of_tables]]
 * - Comments (# ...)
 */
export function parseTomlFallback(src) {
  const root = {}
  let currentTable = root
  const lines = String(src || "").split(/\r?\n/)

  let i = 0
  while (i < lines.length) {
    let line = lines[i].trim()
    i++
    if (!line || line.startsWith("#")) continue

    // Array of tables: [[section]]
    if (line.startsWith("[[") && line.endsWith("]]")) {
      const path = line.slice(2, -2).trim().split(".")
      let curr = root
      for (let p = 0; p < path.length - 1; p++) {
        const seg = path[p].trim()
        if (!curr[seg] || typeof curr[seg] !== "object") curr[seg] = {}
        curr = curr[seg]
      }
      const last = path[path.length - 1].trim()
      if (!Array.isArray(curr[last])) curr[last] = []
      const newTable = {}
      curr[last].push(newTable)
      currentTable = newTable
      continue
    }

    // Standard table: [section]
    if (line.startsWith("[") && line.endsWith("]")) {
      const path = line.slice(1, -1).trim().split(".")
      let curr = root
      for (const rawSeg of path) {
        const seg = rawSeg.trim()
        if (!curr[seg] || typeof curr[seg] !== "object") curr[seg] = {}
        curr = curr[seg]
      }
      currentTable = curr
      continue
    }

    // Key = Value
    const eqIdx = line.indexOf("=")
    if (eqIdx < 0) continue
    const rawKey = line.slice(0, eqIdx).trim()
    let valStr = stripInlineComment(line.slice(eqIdx + 1).trim())

    // Dotted keys (`parameters.command = "ls"`) name a nested table; models
    // emit them when they forget the `[parameters]` header.
    const keyPath = splitDottedKey(rawKey)
    let target = currentTable
    for (let p = 0; p < keyPath.length - 1; p++) {
      const seg = keyPath[p]
      if (!target[seg] || typeof target[seg] !== "object" || Array.isArray(target[seg])) target[seg] = {}
      target = target[seg]
    }
    const key = keyPath[keyPath.length - 1]

    // Multi-line basic string: """
    if (valStr.startsWith('"""')) {
      let strContent = valStr.slice(3)
      if (strContent.endsWith('"""') && strContent.length >= 3) {
        target[key] = unescapeBasicString(strContent.slice(0, -3))
      } else {
        const parts = [strContent]
        let closed = false
        while (i < lines.length) {
          const nextLine = lines[i]
          i++
          if (nextLine.includes('"""')) {
            const endIdx = nextLine.indexOf('"""')
            parts.push(nextLine.slice(0, endIdx))
            closed = true
            break
          } else {
            parts.push(nextLine)
          }
        }
        target[key] = unescapeBasicString(parts.join("\n"))
      }
      continue
    }

    // Multi-line literal string: '''
    if (valStr.startsWith("'''")) {
      let strContent = valStr.slice(3)
      if (strContent.endsWith("'''") && strContent.length >= 3) {
        target[key] = trimLeadingNewline(strContent.slice(0, -3))
      } else {
        const parts = [strContent]
        while (i < lines.length) {
          const nextLine = lines[i]
          i++
          if (nextLine.includes("'''")) {
            const endIdx = nextLine.indexOf("'''")
            parts.push(nextLine.slice(0, endIdx))
            break
          } else {
            parts.push(nextLine)
          }
        }
        target[key] = trimLeadingNewline(parts.join("\n"))
      }
      continue
    }

    // Multiline array: [ ...
    if (valStr.startsWith("[") && !valStr.endsWith("]")) {
      const parts = [valStr]
      while (i < lines.length) {
        const nextLine = lines[i].trim()
        i++
        parts.push(nextLine)
        if (nextLine.includes("]")) break
      }
      valStr = parts.join(" ")
    }

    target[key] = parseTomlValue(valStr)
  }

  return root
}

/**
 * Splits a possibly dotted key into its segments, respecting quoted segments.
 */
function splitDottedKey(rawKey) {
  const key = rawKey.trim()
  if (!key.includes(".")) return [key.replace(/^['"]|['"]$/g, "")]

  const segments = []
  let current = ""
  let quote = ""
  for (let i = 0; i < key.length; i++) {
    const ch = key[i]
    if (quote) {
      current += ch
      if (ch === quote && key[i - 1] !== "\\") quote = ""
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ".") {
      segments.push(current.trim().replace(/^['"]|['"]$/g, ""))
      current = ""
    } else {
      current += ch
    }
  }
  segments.push(current.trim().replace(/^['"]|['"]$/g, ""))
  return segments.length > 1 ? segments : [key.replace(/^['"]|['"]$/g, "")]
}

/**
 * Drops a trailing `# comment` from a value, leaving `#` inside quotes alone.
 */
function stripInlineComment(v) {
  let inBasic = false
  let inLiteral = false
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]
    if (inBasic) {
      if (ch === "\\") i++
      else if (ch === '"') inBasic = false
    } else if (inLiteral) {
      if (ch === "'") inLiteral = false
    } else if (ch === '"') {
      inBasic = true
    } else if (ch === "'") {
      inLiteral = true
    } else if (ch === "#") {
      return v.slice(0, i).trim()
    }
  }
  return v
}

function escapeBasic(s) {
  // Every quote escaped keeps a `"""` run from closing the string early.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function trimLeadingNewline(s) {
  return s.startsWith("\n") ? s.slice(1) : s
}

function unescapeBasicString(s) {
  // Trim single leading newline if present (TOML standard for multiline strings)
  s = trimLeadingNewline(s)
  // One pass, so `\\n` stays a backslash and an n rather than becoming a newline.
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, esc) => {
    if (esc[0] === "u" || esc[0] === "U") {
      try {
        return String.fromCodePoint(parseInt(esc.slice(1), 16))
      } catch {
        return esc
      }
    }
    switch (esc) {
      case "n": return "\n"
      case "r": return "\r"
      case "t": return "\t"
      case "b": return "\b"
      case "f": return "\f"
      case '"': return '"'
      case "\\": return "\\"
      default: return esc
    }
  })
}

function parseTomlValue(v) {
  v = String(v || "").trim()
  // Inline basic string
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v)
    } catch {
      return unescapeBasicString(v.slice(1, -1))
    }
  }
  // Inline literal string
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1)
  }
  // Booleans
  if (v === "true") return true
  if (v === "false") return false
  // Integers and Floats
  if (/^[+-]?\d+$/.test(v)) return parseInt(v, 10)
  if (/^[+-]?(?:\d+\.\d+|\d+\.|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)) return parseFloat(v)
  // Arrays
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return []
    // Tokenize items inside array respecting quotes
    const items = []
    let current = ""
    let inQuotes = false
    let quoteChar = ""
    for (let j = 0; j < inner.length; j++) {
      const ch = inner[j]
      if (inQuotes) {
        current += ch
        if (ch === quoteChar && inner[j - 1] !== "\\") {
          inQuotes = false
        }
      } else if (ch === '"' || ch === "'") {
        inQuotes = true
        quoteChar = ch
        current += ch
      } else if (ch === ",") {
        items.push(parseTomlValue(current.trim()))
        current = ""
      } else {
        current += ch
      }
    }
    if (current.trim()) {
      items.push(parseTomlValue(current.trim()))
    }
    return items
  }
  // Inline table { k = "v" }
  if (v.startsWith("{") && v.endsWith("}")) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return {}
    return parseTomlFallback(inner.replace(/,/g, "\n"))
  }
  return v
}

/**
 * Converts a JavaScript value/object into clean TOML syntax.
 */
export function stringifyToml(val, keyPrefix = "") {
  if (val === null || val === undefined) return ""
  if (typeof val !== "object" || Array.isArray(val)) {
    return formatTomlValue(val)
  }

  const primitives = []
  const tables = []

  for (const [k, v] of Object.entries(val)) {
    if (v === undefined || v === null) continue
    if (typeof v === "object" && !Array.isArray(v)) {
      tables.push([k, v])
    } else {
      primitives.push(`${formatTomlKey(k)} = ${formatTomlValue(v)}`)
    }
  }

  const out = []
  if (primitives.length > 0) {
    out.push(primitives.join("\n"))
  }

  for (const [k, sub] of tables) {
    const tableHeader = keyPrefix ? `${keyPrefix}.${formatTomlKey(k)}` : formatTomlKey(k)
    out.push(`\n[${tableHeader}]\n${stringifyToml(sub, tableHeader)}`.trim())
  }

  return out.join("\n")
}

function formatTomlKey(key) {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key
  return JSON.stringify(key)
}

function formatTomlValue(val) {
  if (val === null || val === undefined) return '""'
  if (typeof val === "boolean") return val ? "true" : "false"
  if (typeof val === "number") return String(val)
  if (typeof val === "string") {
    if (val.includes("\n")) {
      // A literal multiline string keeps backslashes, quotes and `$` exactly
      // as written — which is the point of TOML for shell snippets. The
      // delimiters hug the content: a newline right after `'''` is trimmed by
      // the spec but kept by some parsers, and hugging both agree.
      // Content holding `'''`, or ending in a quote, would run into the
      // closing delimiter, so it goes into an escaped basic string instead.
      if (!val.includes("'''") && !val.endsWith("'")) return `'''${val}'''`
      return `"""${escapeBasic(val)}"""`
    }
    return JSON.stringify(val)
  }
  if (Array.isArray(val)) {
    return `[${val.map(formatTomlValue).join(", ")}]`
  }
  if (typeof val === "object") {
    // Inline table for objects nested inside a value
    const entries = Object.entries(val).map(([k, v]) => `${formatTomlKey(k)} = ${formatTomlValue(v)}`)
    return `{ ${entries.join(", ")} }`
  }
  return JSON.stringify(String(val))
}

/**
 * Regex matching tool call fences in model output.
 * Recognizes ```tool_call, ```tool_call toml, ```tool_call:toml, and ```toml_tool_call.
 */
export const TOOL_CALL_BLOCK_RE = /```(?:tool_call(?:\s*toml|\s*TOML|\s*:toml)?|toml_tool_call)\s*\n?([\s\S]*?)```/g

/**
 * Extracts and normalizes tool calls from model output containing TOML blocks.
 * Returns { cleanText, toolCalls }.
 */
export function parseToolCalls(text) {
  if (!text || typeof text !== "string") {
    return { cleanText: "", toolCalls: [] }
  }

  const toolCalls = []
  const matches = [...text.matchAll(TOOL_CALL_BLOCK_RE)]

  for (const match of matches) {
    const blockContent = match[1]?.trim()
    if (!blockContent) continue

    let parsed
    try {
      parsed = parseToml(blockContent)
    } catch {
      parsed = null
    }

    let normalized = normalizeTomlToolCalls(parsed)
    if (normalized.length === 0) {
      // The instructions ask for TOML, but a model that answered a legacy
      // prompt with JSON inside the same fence should not lose its call.
      try {
        normalized = normalizeTomlToolCalls(JSON.parse(blockContent))
      } catch {}
    }

    for (const call of normalized) {
      toolCalls.push({
        id: call.id || `call_${randomBytes(8).toString("hex")}`,
        type: "function",
        function: {
          name: call.name,
          arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments || {}),
        },
      })
    }
  }

  const cleanText = text.replace(TOOL_CALL_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim()
  return { cleanText, toolCalls }
}

/**
 * Normalizes different TOML structures that the model might generate:
 * 1. Root table: name = "...", [parameters] / [arguments] ...
 * 2. Root table: name = "...", key = "value"
 * 3. [tool_call] name = "...", ...
 * 4. [[tool_calls]] array of tables
 */
export function normalizeTomlToolCalls(parsed) {
  if (!parsed || typeof parsed !== "object") return []

  if (Array.isArray(parsed)) {
    return parsed.map((item) => normalizeSingleToolCall(item)).filter(Boolean)
  }

  const list = parsed.tool_calls || parsed.tool_call
  if (Array.isArray(list)) {
    return list.map((item) => normalizeSingleToolCall(item)).filter(Boolean)
  }

  if (parsed.tool_call && typeof parsed.tool_call === "object" && !Array.isArray(parsed.tool_call)) {
    // A model that opens `[tool_call]` and then a bare `[parameters]` leaves
    // the arguments at the root, not under tool_call — put them back.
    const merged = { ...parsed.tool_call }
    for (const key of ["parameters", "arguments", "args"]) {
      if (parsed[key] !== undefined && merged[key] === undefined) merged[key] = parsed[key]
    }
    const res = normalizeSingleToolCall(merged)
    return res ? [res] : []
  }

  const res = normalizeSingleToolCall(parsed)
  return res ? [res] : []
}

export function sanitizeArgumentValue(val) {
  if (typeof val === "string") {
    let s = val.trim()
    // Strip trailing XML parameter tags like </parameter>, </param>, </arg>, </value>
    s = s.replace(/<\/(?:parameter|param|arg|value)>/gi, "").trim()
    // Strip leading XML parameter tags like <parameter name="...">
    s = s.replace(/^<(?:parameter|param|arg|value)(?:\s+[^>]*)?>/gi, "").trim()
    // If the model wrapped the inner value in extra quotes like "\"find ...\""
    if (
      (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
      (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
    ) {
      s = s.slice(1, -1).trim()
    }
    return s
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeArgumentValue)
  }
  if (val && typeof val === "object") {
    return sanitizeArgumentObject(val)
  }
  return val
}

export function sanitizeArgumentObject(obj) {
  if (!obj || typeof obj !== "object") return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const cleanKey = k.replace(/<\/?(?:parameter|param|arg|value)[^>]*>/gi, "").trim()
    out[cleanKey || k] = sanitizeArgumentValue(v)
  }
  return out
}

function normalizeSingleToolCall(item) {
  if (!item || typeof item !== "object") return null
  const fnObj = item.function && typeof item.function === "object" ? item.function : null
  const name =
    item.name ||
    fnObj?.name ||
    (typeof item.function === "string" ? item.function : null) ||
    item.tool
  if (!name || typeof name !== "string") return null

  // Accepts arguments across Codex (arguments/parameters) and Claude Code (input)
  let rawArgs =
    item.input ??
    item.arguments ??
    item.parameters ??
    item.args ??
    fnObj?.arguments ??
    fnObj?.input ??
    fnObj?.parameters

  let args = {}
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs
  } else if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed
      } else {
        args = rawArgs
      }
    } catch {
      args = rawArgs
    }
  } else {
    const remaining = {}
    for (const [k, v] of Object.entries(item)) {
      if (
        k !== "name" &&
        k !== "id" &&
        k !== "type" &&
        k !== "function" &&
        k !== "tool" &&
        k !== "input"
      ) {
        remaining[k] = v
      }
    }
    args = remaining
  }

  const sanitized =
    typeof args === "object" && args !== null
      ? sanitizeArgumentObject(args)
      : sanitizeArgumentValue(args)

  return {
    id: item.id || `call_${randomBytes(8).toString("hex")}`,
    name: name.trim(),
    arguments: sanitized,
  }
}

const OPEN_MARKERS = ["```tool_call", "```toml_tool_call", "```tool_call_base64", "```base64_tool_call"]
const CLOSE_MARKER = "```"

/**
 * Gate that buffers streaming text deltas to prevent raw tool call fences
 * from leaking into the user-visible content stream.
 *
 * Text outside fences goes out as it arrives; everything from an opening
 * fence to its closing one is held back, and so is a tail that could still
 * turn out to be the start of a fence. `sent` is what the client actually
 * received, which is always a prefix of the full reply.
 *
 * Every format's opening marker is held, whichever one the request asked for:
 * a model that ignores the instruction still must not leak its fence.
 */
export class ToolFenceGate {
  constructor(emit, markers = OPEN_MARKERS) {
    this.emit = emit
    this.markers = markers
    this.buf = ""
    this.inFence = false
    this.openMarker = ""
    this.sent = ""
  }

  send(str) {
    if (!str) return
    this.sent += str
    this.emit(str)
  }

  push(delta) {
    this.buf += delta
    while (true) {
      if (this.inFence) {
        const j = this.buf.indexOf(CLOSE_MARKER)
        if (j < 0) return // In fence, hold back until closing fence arrives
        this.buf = this.buf.slice(j + CLOSE_MARKER.length)
        this.inFence = false
        this.openMarker = ""
        continue
      }
      const open = earliestMarker(this.buf, this.markers)
      if (open) {
        this.send(this.buf.slice(0, open.index))
        this.buf = this.buf.slice(open.index + open.marker.length)
        this.inFence = true
        this.openMarker = open.marker
        continue
      }
      const keep = Math.max(...this.markers.map((m) => partialPrefixLen(this.buf, m)))
      if (keep > 0) {
        this.send(this.buf.slice(0, this.buf.length - keep))
        this.buf = this.buf.slice(this.buf.length - keep)
        return
      }
      this.send(this.buf)
      this.buf = ""
      return
    }
  }

  /**
   * Releases whatever is still buffered. A fence the model never closed is
   * sent with its opening marker, since there is nothing to parse and
   * dropping it would lose the only answer there is.
   */
  flush() {
    const held = this.buf
    const marker = this.openMarker
    this.buf = ""
    this.inFence = false
    this.openMarker = ""
    if (marker || held) this.send(marker + held)
  }
}

function earliestMarker(s, markers) {
  let found = null
  for (const marker of markers) {
    const index = s.indexOf(marker)
    if (index >= 0 && (!found || index < found.index)) found = { index, marker }
  }
  return found
}

function partialPrefixLen(s, marker) {
  const max = Math.min(marker.length - 1, s.length)
  for (let k = max; k > 0; k--) {
    if (marker.startsWith(s.slice(s.length - k))) {
      return k
    }
  }
  return 0
}

/**
 * Formats OpenAI tool_calls into TOML ```tool_call blocks for feeding back into model context.
 */
export function formatToolCallsToToml(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return ""
  const blocks = []
  for (const tc of toolCalls) {
    const fn = tc.function || tc
    const name = fn.name || "tool"
    let argsObj = {}
    if (typeof fn.arguments === "string") {
      try {
        argsObj = JSON.parse(fn.arguments)
      } catch {
        argsObj = { raw: fn.arguments }
      }
    } else if (typeof fn.arguments === "object" && fn.arguments !== null) {
      argsObj = fn.arguments
    }

    const lines = [`name = ${JSON.stringify(name)}`]
    const argsToml = stringifyToml(argsObj)
    if (argsToml.trim()) {
      lines.push("")
      lines.push("[parameters]")
      lines.push(argsToml)
    }

    blocks.push("```tool_call\n" + lines.join("\n") + "\n```")
  }
  return blocks.join("\n\n")
}

const EXIT_CODE_RE = /(?:exit(?:ed with|\s*code)?\s*(?:code\s*)?|returncode\s*[:=]\s*)(\d+)/i

/**
 * Formats a tool execution result cleanly so the model clearly identifies success vs failure.
 */
export function formatToolResult(name, raw) {
  const label = name ? `Tool result for ${name}` : "Tool result"
  const trimmed = String(raw || "").trim()

  if (!trimmed) {
    return `[${label}]: ✅ Command succeeded (exit 0) with no text output. The action is complete; do not re-run it.`
  }

  // Handle Codex/agent wrappers where stdout follows "Output:"
  let out = trimmed
  const outputIdx = trimmed.lastIndexOf("Output:")
  if (outputIdx >= 0) {
    out = trimmed.slice(outputIdx + "Output:".length).trim()
  }

  const m = trimmed.match(EXIT_CODE_RE)
  if (m) {
    const code = m[1]
    if (code === "0") {
      if (!out) {
        return `[${label}]: ✅ Command succeeded (exit 0) with no text output. The action is complete; do not re-run it.`
      }
      return `[${label}]: ✅ Command succeeded (exit 0). Output:\n${out}`
    }
    return `[${label}]: ❌ Command failed (exit ${code}). Output:\n${out}`
  }

  return `[${label}]: ${trimmed}`
}

/**
 * Parses OpenAI tool_choice parameter.
 */
export function parseToolChoice(toolChoice) {
  if (typeof toolChoice === "string") {
    if (toolChoice === "none" || toolChoice === "required" || toolChoice === "auto") {
      return { mode: toolChoice, forced: null }
    }
  } else if (typeof toolChoice === "object" && toolChoice !== null) {
    if (toolChoice.type === "function" && toolChoice.function?.name) {
      return { mode: "required", forced: toolChoice.function.name }
    }
  }
  return { mode: "auto", forced: null }
}

/**
 * Builds the system instructions for tools, mandating TOML for all tool call parameters.
 */
export function buildToolsPrompt(tools, toolChoice) {
  const { mode, forced } = parseToolChoice(toolChoice)
  if (!Array.isArray(tools) || tools.length === 0 || mode === "none") {
    return null
  }

  const defs = []
  for (const t of tools) {
    const fn = t.function || t
    const name = fn.name || ""
    if (forced && name !== forced) continue
    defs.push({
      name,
      description: fn.description || "",
      parameters: fn.parameters || {},
    })
  }

  if (defs.length === 0) return null

  let rule = "Only use tool_call blocks when needed."
  if (forced) {
    rule = `You MUST call the tool "${forced}". Reply with the tool_call block in TOML format and nothing else — do not answer the question yourself, even if you know the answer.`
  } else if (mode === "required") {
    rule = "You MUST call one of the tools above. Reply with the tool_call block in TOML format and nothing else — do not answer the question yourself, even if you know the answer."
  }

  const defsJson = JSON.stringify(defs, null, 2)

  return (
    `[System instruction]: You have access to the following tools:\n` +
    `\`\`\`json\n${defsJson}\n\`\`\`\n\n` +
    `CRITICAL INSTRUCTION: Tool calls MUST be formatted as a \`\`\`tool_call code block with parameters in TOML format.\n` +
    `DO NOT USE JSON for tool calls or parameters. Always transmit parameters in TOML format.\n\n` +
    `Format:\n` +
    `\`\`\`tool_call\n` +
    `name = "tool_name"\n\n` +
    `[parameters]\n` +
    `param1 = "value1"\n` +
    `param2 = 42\n` +
    `multiline_param = """\nline 1\nline 2\n"""\n` +
    `\`\`\`\n\n` +
    `If a tool takes no parameters:\n` +
    `\`\`\`tool_call\n` +
    `name = "tool_name"\n` +
    `\`\`\`\n\n` +
    `${rule}`
  )
}

/**
 * Builds the high-priority ending anchor prompt reminding the model to use TOML tool calls.
 * Placed at the very end of the prompt to avoid being overridden by large client prompts.
 */
export function buildAnchorPrompt(tools, toolChoice) {
  const { mode, forced } = parseToolChoice(toolChoice)
  if (!Array.isArray(tools) || tools.length === 0 || mode === "none") {
    return null
  }

  const names = tools
    .map((t) => t?.function?.name || t?.name)
    .filter((n) => typeof n === "string" && n)
  const sampleToolName = forced || names[0] || "run_command"

  // The names ride along so a continuing turn still knows them even when the
  // full schemas are only in the session's first system block — and so a
  // tool an agent added mid-conversation is not invisible.
  const nameList = names.length > 0 ? `Available tools: ${names.join(", ")}.\n` : ""

  return (
    `[System instruction — highest priority]: To run a command, read/edit a file, or perform actions, you MUST ` +
    `output a \`\`\`tool_call\`\`\` block in TOML format — this is the ONLY execution channel. ` +
    `Markdown code blocks like \`\`\`bash, \`\`\`powershell, \`\`\`cmd, \`\`\`python are NOT executed by the system and are only ` +
    `shown to the user; never use them to run anything, and never claim you lack tools.\n` +
    `${nameList}` +
    `CRITICAL: Tool call parameters MUST ALWAYS be in TOML format, NOT JSON.\n` +
    `Act, do not explain: when the request needs a tool, your reply is ONE \`\`\`tool_call\`\`\` block in TOML and nothing else ` +
    `— do not list commands you 'would' run, do not output prose. If several steps are needed, do the FIRST one now; ` +
    `you will be called again with its result to continue.\n` +
    `Know when to STOP: once a tool result shows a step succeeded (for example exit code 0), that step is DONE — do not ` +
    `run it again and do not retry the same thing. When the whole request is accomplished, stop calling tools and reply ` +
    `with a short final answer.\n` +
    `Example of a correct turn in TOML format — user asks "run the check", you reply with exactly one block in TOML and nothing else:\n` +
    `\`\`\`tool_call\n` +
    `name = "${sampleToolName}"\n\n` +
    `[parameters]\n` +
    `command = "npm test"\n` +
    `\`\`\`\n` +
    `(Remember: parameters MUST ALWAYS be in TOML format, NOT JSON. In your block use one of the real tool names listed above with its own arguments.) ` +
    `When the request needs a tool, emit the tool_call block now.`
  )
}

// ---------------------------------------------------------------------------
// Base64 tool calls
//
// The second format the plugin can ask for. Where the TOML one reads well in a
// transcript, this one is short and has nothing a web model can break: a base64
// alphabet has no braces, quotes, newlines or escapes, so a long shell command
// or a file body passes through without any escaping at all. The model encodes
// a JSON document; the prompt shows it an encoded example, so what it copies is
// the alphabet rather than the JSON shape.
// ---------------------------------------------------------------------------

/**
 * The fence a base64 tool call arrives in. `tool_call_base64` is what the
 * instructions ask for; the rest are what models emit when they improvise.
 */
export const BASE64_TOOL_CALL_RE =
  /```(?:tool_call(?:_tool_call)?[:\s_-]*(?:base64|b64)|base64_tool_call|tool_call)\s*\n?([A-Za-z0-9+/=_\-\s]+?)```/g

/**
 * Whether a fenced block is base64 rather than TOML/JSON. A TOML call starts
 * with `name =` and a JSON one with `{`, so a block made only of the base64
 * alphabet is not either of them.
 */
export function looksBase64(block) {
  const compact = String(block || "").replace(/\s+/g, "")
  if (compact.length < 8) return false
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) return false
  // a plain word (`tool_name`) passes the alphabet test; real base64 of a JSON
  // document is longer and decodes to something that starts with `{`
  return compact.length >= 16 || /[A-Z0-9+/=]/.test(compact)
}

/**
 * Parses Claude Code / Anthropic style XML tool use inside decoded content:
 * <tool_use><name>...</name><input>...</input></tool_use> or
 * <invoke name="..."><parameter name="...">...</parameter></invoke>.
 */
export function parseXmlToolCalls(text) {
  if (!text || typeof text !== "string") return []
  const calls = []

  // Anthropic / Claude Code style: <tool_use><name>tool</name><input>...</input></tool_use>
  const toolUseMatches = [...text.matchAll(/<tool_use>([\s\S]*?)<\/tool_use>/gi)]
  for (const m of toolUseMatches) {
    const inner = m[1]
    const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/i)
    const name = nameMatch ? nameMatch[1].trim() : ""
    if (!name) continue
    const inputMatch = inner.match(/<input>([\s\S]*?)<\/input>/i)
    let args = {}
    if (inputMatch) {
      const rawInput = inputMatch[1].trim()
      try {
        args = JSON.parse(rawInput)
      } catch {
        const tags = [...rawInput.matchAll(/<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g)]
        for (const t of tags) args[t[1]] = t[2].trim()
      }
    }
    calls.push({ name, arguments: args })
  }
  if (calls.length > 0) return calls

  // Invoke style: <invoke name="tool_name"><parameter name="key">val</parameter></invoke>
  const invokeMatches = [...text.matchAll(/<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi)]
  for (const m of invokeMatches) {
    const name = m[1].trim()
    const inner = m[2]
    const args = {}
    const params = [...inner.matchAll(/<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi)]
    for (const p of params) {
      args[p[1]] = p[2].trim()
    }
    calls.push({ name, arguments: args })
  }
  return calls
}

/**
 * Decodes a base64 block into a tool call. Returns null when the text is not
 * base64, does not decode to UTF-8, or decodes to something with no tool call
 * in it — so a caller can tell "not this format" from "this format, bad call".
 */
export function parseBase64ToolCall(block) {
  const compact = String(block || "").replace(/\s+/g, "")
  if (!compact) return null

  let text
  try {
    // url-safe alphabets appear when a model re-encodes carelessly
    const normalized = compact.replace(/-/g, "+").replace(/_/g, "/")
    text = Buffer.from(normalized, "base64").toString("utf8")
  } catch {
    return null
  }
  if (!text || text.includes("�")) return null // not UTF-8: not our payload

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // If the base64 payload decodes to Claude Code XML tool use
    const xmlCalls = parseXmlToolCalls(text)
    if (xmlCalls.length > 0) {
      const norm = normalizeJsonToolCalls(xmlCalls)
      if (norm.length > 0) return norm
    }

    // Some models add the name on a line before the encoded JSON; take the
    // longest base64-looking run and try that alone.
    const runs = text.match(/[A-Za-z0-9+/=_-]{16,}/g) || []
    for (const run of runs) {
      try {
        const inner = JSON.parse(Buffer.from(run.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
        const calls = normalizeJsonToolCalls(inner)
        if (calls.length > 0) return calls
      } catch {}
    }
    return null
  }

  const calls = normalizeJsonToolCalls(parsed)
  return calls.length > 0 ? calls : null
}

/**
 * Normalizes the JSON document a model encoded into tool calls:
 * `{name, arguments}` / `{tool, parameters}` / `{tool_calls: [...]}`.
 */
export function normalizeJsonToolCalls(parsed) {
  return normalizeTomlToolCalls(parsed)
}

/**
 * Encodes a tool call as the model is asked to return it: the JSON document,
 * base64-encoded, in a `tool_call_base64` fence.
 */
export function encodeToolCallBase64(name, args) {
  const doc = { name, arguments: args ?? {} }
  const encoded = Buffer.from(JSON.stringify(doc), "utf8").toString("base64")
  return "```tool_call_base64\n" + encoded + "\n```"
}

/**
 * Formats OpenAI tool_calls as the encoded blocks a fresh session's history
 * shows, so the model's own past calls look like what it is asked to produce.
 */
export function formatToolCallsToBase64(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return ""
  return toolCalls
    .map((tc) => {
      const fn = tc.function || tc
      let args = {}
      if (typeof fn.arguments === "string") {
        try {
          args = JSON.parse(fn.arguments)
        } catch {
          args = { raw: fn.arguments }
        }
      } else if (fn.arguments && typeof fn.arguments === "object") {
        args = fn.arguments
      }
      return encodeToolCallBase64(fn.name || "tool", args)
    })
    .join("\n\n")
}

/**
 * Extracts tool calls from base64-fenced blocks. Returns { cleanText, toolCalls }.
 */
export function parseBase64ToolCalls(text) {
  if (!text || typeof text !== "string") {
    return { cleanText: "", toolCalls: [] }
  }

  const toolCalls = []
  const matches = [...text.matchAll(BASE64_TOOL_CALL_RE)]

  for (const match of matches) {
    const block = match[1]
    if (!looksBase64(block)) continue
    const calls = parseBase64ToolCall(block)
    if (!calls) continue
    for (const call of calls) {
      toolCalls.push({
        id: call.id || `call_${randomBytes(8).toString("hex")}`,
        type: "function",
        function: {
          name: call.name,
          arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments || {}),
        },
      })
    }
  }

  const cleanText = toolCalls.length > 0
    ? text.replace(BASE64_TOOL_CALL_RE, "").replace(/\n{3,}/g, "\n\n").trim()
    : text.trim()
  return { cleanText, toolCalls }
}

/**
 * The system instructions for the base64 format: the schemas, the encoding
 * rule, and one worked example whose encoded text is generated here rather
 * than made up, so the model copies a real alphabet.
 */
export function buildBase64ToolsPrompt(tools, toolChoice) {
  const { mode, forced } = parseToolChoice(toolChoice)
  if (!Array.isArray(tools) || tools.length === 0 || mode === "none") {
    return null
  }

  const defs = []
  for (const t of tools) {
    const fn = t.function || t
    const name = fn.name || ""
    if (forced && name !== forced) continue
    defs.push({ name, description: fn.description || "", parameters: fn.parameters || {} })
  }
  if (defs.length === 0) return null

  let rule = "Only produce a tool_call block when a tool is needed."
  if (forced) {
    rule = `You MUST call the tool "${forced}". Reply with the encoded block and nothing else — do not answer the question yourself.`
  } else if (mode === "required") {
    rule = "You MUST call one of the tools above. Reply with the encoded block and nothing else — do not answer the question yourself."
  }

  const sample = encodeToolCallBase64(defs[0].name, { command: "npm test" })
  const sampleDoc = JSON.stringify({ name: defs[0].name, arguments: { command: "npm test" } })

  return (
    `[System instruction]: You have access to the following tools:\n` +
    `\`\`\`json\n${JSON.stringify(defs, null, 2)}\n\`\`\`\n\n` +
    `To call a tool, do NOT write JSON or TOML in your reply. Encode the call as base64 and send only the encoding:\n` +
    `1. Build the tool call in standard Codex or Claude Code JSON format:\n` +
    `   Codex: {"name": "<tool name>", "arguments": {<the tool's arguments>}}\n` +
    `   Claude Code: {"type": "tool_use", "name": "<tool name>", "input": {<the tool's arguments>}}\n` +
    `2. Encode that exact JSON text as base64 (UTF-8).\n` +
    `3. Reply with one fenced block, the tag \`tool_call_base64\` and the encoded text alone:\n\n` +
    `${sample}\n\n` +
    `That example decodes to:\n` +
    `${sampleDoc}\n\n` +
    `Rules: the block holds base64 only — no JSON, no prose, no line breaks needed. ` +
    `A tool with no arguments encodes {"name": "<tool name>", "arguments": {}}. ` +
    `CRITICAL: Argument values must be raw values. DO NOT wrap values in XML tags like <parameter> or </parameter>. ` +
    `DO NOT add extra quotes inside string arguments. ` +
    `One tool call per reply unless several are needed; then use one block each.\n` +
    `${rule}`
  )
}

/**
 * The end-of-prompt anchor for the base64 format. Same reasoning as the TOML
 * one: a long agent prompt buries a format stated only at the top.
 */
export function buildBase64AnchorPrompt(tools, toolChoice) {
  const { mode, forced } = parseToolChoice(toolChoice)
  if (!Array.isArray(tools) || tools.length === 0 || mode === "none") {
    return null
  }

  const names = tools.map((t) => t?.function?.name || t?.name).filter((n) => typeof n === "string" && n)
  const sampleName = forced || names[0] || "run_command"
  const sample = encodeToolCallBase64(sampleName, { command: "npm test" })
  const nameList = names.length > 0 ? `Available tools: ${names.join(", ")}.\n` : ""

  return (
    `[System instruction — highest priority]: To run a command, read/edit a file, or perform actions, you MUST ` +
    `call a tool by replying with a \`\`\`tool_call_base64\`\`\` block holding base64-encoded JSON — this is the ONLY ` +
    `execution channel. Markdown code blocks like \`\`\`bash, \`\`\`powershell, \`\`\`cmd, \`\`\`python are NOT executed by ` +
    `the system and are only shown to the user; never use them to run anything, and never claim you lack tools.\n` +
    `${nameList}` +
    `CRITICAL: the block must contain base64 ONLY. Do not put JSON, TOML or prose in it.\n` +
    `CRITICAL: All parameter values must be raw values. DO NOT include XML tags (NO <parameter>, NO </parameter>).\n` +
    `Act, do not explain: when the request needs a tool, your reply is ONE \`\`\`tool_call_base64\`\`\` block and nothing ` +
    `else — do not list commands you 'would' run, do not output prose. If several steps are needed, do the FIRST one ` +
    `now; you will be called again with its result to continue.\n` +
    `Know when to STOP: once a tool result shows a step succeeded (for example exit code 0), that step is DONE — do ` +
    `not run it again and do not retry the same thing. When the whole request is accomplished, stop calling tools and ` +
    `reply with a short final answer.\n` +
    `Example — user asks "run the check", you reply with exactly one block:\n` +
    `${sample}\n` +
    `(It decodes to {"name": "${sampleName}", "arguments": {"command": "npm test"}}. Use a real tool name from the ` +
    `list above and its own arguments.) When the request needs a tool, emit the encoded block now.`
  )
}

/**
 * Picks the tool-call wire format: "toml" or "base64". The plugin option wins,
 * then the environment, then TOML.
 */
export function resolveToolFormat(optionValue, env = typeof process !== "undefined" ? process.env : {}) {
  const raw = String(optionValue ?? env?.DEEPSEEK_WEB_TOOL_FORMAT ?? "").trim().toLowerCase()
  if (raw === "toml") return "toml"
  if (raw === "base64" || raw === "b64" || raw === "encoded") return "base64"
  return "base64"
}

/**
 * Parses a reply in the configured format, falling back to the other one:
 * whichever a model actually emitted is more useful than nothing.
 */
export function parseToolCallsAnyFormat(text, format = "toml") {
  const first = format === "base64" ? parseBase64ToolCalls(text) : parseToolCalls(text)
  if (first.toolCalls.length > 0) return { ...first, format }
  const second = format === "base64" ? parseToolCalls(text) : parseBase64ToolCalls(text)
  if (second.toolCalls.length > 0) return { ...second, format: format === "base64" ? "toml" : "base64" }
  return { cleanText: text, toolCalls: [], format }
}

/**
 * The prompts for a format, as one call site uses them.
 */
export function toolPromptsFor(format, tools, toolChoice) {
  return format === "base64"
    ? { build: buildBase64ToolsPrompt, anchor: buildBase64AnchorPrompt, formatCalls: formatToolCallsToBase64 }
    : { build: buildToolsPrompt, anchor: buildAnchorPrompt, formatCalls: formatToolCallsToToml }
}
