import { randomBytes } from "node:crypto"

export class ToolProtocolError extends Error {
  constructor(message) {
    super(`Invalid tool call: ${message}`)
    this.name = "ToolProtocolError"
    this.code = "invalid_tool_call"
  }
}

// The same scanner owns both parsing and content suppression. Tool-bearing
// responses are held until complete: no partial call can escape as text, and
// no call from a malformed parallel batch is executed on its own.
const OPEN = /```(?:tool_call_base64|base64_tool_call|toml_tool_call|json_tool_call|tool_calls|tool_call|tool-call)(?=\s|:|$)|<tool_call>|<\s*[｜|](?:\s*[｜|])?\s*DSML\s*[｜|](?:\s*[｜|])?\s*[a-z_]+\b[^>]*>/gi
const DSML_TAG = /<(\/?)\s*[｜|](?:\s*[｜|])?\s*DSML\s*[｜|](?:\s*[｜|])?\s*([a-z_]+)\b([^>]*)>/gi
const DSML_CLOSE = /<\/\s*[｜|](?:\s*[｜|])?\s*DSML\s*[｜|](?:\s*[｜|])?\s*[a-z_]+\b[^>]*>/gi

function failure(message) {
  throw new ToolProtocolError(message)
}

function attributes(raw) {
  const result = Object.create(null)
  let rest = raw
  const pattern = /\s+([a-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  let match
  let end = 0
  while ((match = pattern.exec(raw))) {
    if (raw.slice(end, match.index).trim()) failure("malformed DSML attributes")
    if (Object.hasOwn(result, match[1])) failure("duplicate DSML attribute")
    result[match[1]] = match[2] ?? match[3]
    end = pattern.lastIndex
  }
  rest = raw.slice(end)
  if (rest.trim()) failure("malformed DSML attributes")
  return result
}

function dsmlCall(source, from) {
  DSML_TAG.lastIndex = from
  const tags = []
  let match
  while ((match = DSML_TAG.exec(source))) {
    tags.push({ closing: Boolean(match[1]), name: match[2], attrs: match[3], start: match.index, end: DSML_TAG.lastIndex })
  }
  let i = 0
  const first = tags[i++]
  if (!first || first.start !== from || first.closing) failure("malformed DSML opening tag")
  const wrapped = ["function_calls", "tool_calls", "calls"].includes(first.name)
  if (!wrapped && first.name !== "invoke") failure("unsupported DSML envelope")
  const calls = []
  let cursor = first.end
  let invoke = wrapped ? null : first
  while (true) {
    if (!invoke) {
      const tag = tags[i++]
      if (!tag) failure("truncated DSML batch")
      if (source.slice(cursor, tag.start).trim()) failure("unexpected text in DSML batch")
      if (tag.closing && tag.name === first.name) {
        if (!calls.length) failure("empty DSML batch")
        return { calls, end: tag.end }
      }
      if (tag.closing || tag.name !== "invoke") failure("expected DSML invoke")
      invoke = tag
    }
    const attrs = attributes(invoke.attrs)
    const args = Object.create(null)
    cursor = invoke.end
    while (true) {
      const tag = tags[i++]
      if (!tag) failure("truncated DSML invoke")
      if (source.slice(cursor, tag.start).trim()) failure("unexpected text in DSML invoke")
      if (tag.closing && tag.name === "invoke") {
        calls.push({ name: attrs.name, arguments: args })
        cursor = tag.end
        break
      }
      if (tag.closing || tag.name !== "parameter") failure("expected DSML parameter")
      const param = attributes(tag.attrs)
      if (!param.name || Object.hasOwn(args, param.name)) failure("missing or duplicate DSML parameter name")
      const close = tags[i++]
      if (!close || !close.closing || close.name !== "parameter") failure("truncated DSML parameter")
      const value = source.slice(tag.end, close.start)
      if (param.string === undefined || param.string === "true") args[param.name] = value
      else if (param.string === "false") {
        try { args[param.name] = JSON.parse(value) } catch { failure("DSML parameter is not valid JSON") }
      } else failure("DSML parameter must declare string=true or string=false")
      cursor = close.end
    }
    if (!wrapped) return { calls, end: cursor }
    invoke = null
  }
}

// Find the end of a fenced document without treating ``` inside a JSON
// string (for example Markdown file content) as the closing delimiter.
function fenceEnd(source, from) {
  let quoted = false
  let escaped = false
  for (let i = from; i < source.length; i++) {
    const char = source[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (source.startsWith("```", i)) return i
  }
  return -1
}

function normalize(document) {
  const list = Array.isArray(document) ? document
    : Array.isArray(document?.tool_calls) ? document.tool_calls
    : Array.isArray(document?.tool_call) ? document.tool_call
    : [document?.tool_call ?? document]
  if (!list.length) failure("empty call batch")
  return list.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) failure("call must be an object")
    const fn = typeof item.function === "object" && item.function !== null ? item.function : item
    const name = fn.name ?? item.name ?? item.tool
    if (typeof name !== "string" || !name.trim()) failure("tool name is missing")
    let args = fn.arguments ?? fn.input ?? fn.parameters ?? fn.args ?? item.input
    if (args === undefined) args = {}
    if (typeof args === "string") {
      try { args = JSON.parse(args) } catch { failure(`arguments for ${name} must be a JSON object`) }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) failure(`arguments for ${name} must be an object`)
    return {
      id: typeof item.id === "string" && item.id ? item.id : `call_${randomBytes(8).toString("hex")}`,
      type: "function",
      function: { name: name.trim(), arguments: JSON.stringify(args) },
    }
  })
}

export function scanToolReply(input, { parseLegacy } = {}) {
  const text = String(input ?? "")
  const calls = []
  const visible = []
  let cursor = 0
  let error = null
  let detected = false
  while (cursor < text.length) {
    OPEN.lastIndex = cursor
    const opening = OPEN.exec(text)
    if (!opening) {
      visible.push(text.slice(cursor))
      break
    }
    detected = true
    visible.push(text.slice(cursor, opening.index))
    let end
    try {
      let documents
      if (opening[0].startsWith("```")) {
        const line = text.indexOf("\n", opening.index)
        if (line < 0) failure("truncated tool fence")
        const header = text.slice(opening.index + 3, line).trim().toLowerCase()
        const close = fenceEnd(text, line + 1)
        if (close < 0) failure("truncated tool fence")
        end = close + 3
        const body = text.slice(line + 1, close).trim()
        if (/base64|b64/.test(header)) failure("Base64 tool calls are disabled; use a JSON tool_call fence")
        try { documents = JSON.parse(body) } catch {
          // TOML compatibility applies only to a clearly TOML document.
          // Never fish a JSON object out of malformed prose or code.
          if (!parseLegacy || !/^(?:name\s*=|\[)/.test(body)) failure("tool fence must contain valid JSON")
          try { documents = parseLegacy(body) } catch { failure("invalid legacy tool document") }
        }
      } else if (opening[0].toLowerCase() === "<tool_call>") {
        const start = opening.index + opening[0].length
        const close = text.indexOf("</tool_call>", start)
        if (close < 0) failure("truncated tool_call wrapper")
        end = close + "</tool_call>".length
        try { documents = JSON.parse(text.slice(start, close)) } catch { failure("tool_call wrapper must contain valid JSON") }
      } else {
        const parsed = dsmlCall(text, opening.index)
        documents = parsed.calls
        end = parsed.end
      }
      calls.push(...normalize(documents))
      cursor = end
    } catch (err) {
      error ??= err instanceof ToolProtocolError ? err : new ToolProtocolError("malformed tool response")
      if (end === undefined) break
      cursor = end
    }
  }
  return { cleanText: visible.join("").replace(DSML_CLOSE, ""), toolCalls: error ? [] : calls, error, detected }
}

export class ToolOutputGate {
  constructor(emit, options = {}) {
    this.emit = emit
    this.options = options
    this.buffer = ""
    this.sent = ""
  }
  push(delta) { this.buffer += delta }
  flush() {
    const { cleanText } = scanToolReply(this.buffer, this.options)
    this.sent = cleanText
    if (cleanText) this.emit(cleanText)
    this.buffer = ""
  }
}

function schemaCheck(value, schema, path, root) {
  if (!schema || typeof schema !== "object") return
  if (schema.$ref?.startsWith("#/")) {
    let resolved = root
    for (const key of schema.$ref.slice(2).split("/")) resolved = resolved?.[key.replace(/~1/g, "/").replace(/~0/g, "~")]
    if (!resolved) failure(`unresolved argument schema at ${path}`)
    return schemaCheck(value, resolved, path, root)
  }
  if (schema.anyOf || schema.oneOf) {
    const options = schema.anyOf ?? schema.oneOf
    const matches = options.filter((candidate) => {
      try { schemaCheck(value, candidate, path, root); return true } catch { return false }
    })
    if (!matches.length || (schema.oneOf && matches.length !== 1)) failure(`wrong argument shape at ${path}`)
  }
  for (const part of schema.allOf ?? []) schemaCheck(value, part, path, root)
  if (schema.enum && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) failure(`invalid enum at ${path}`)
  const types = schema.type ? [].concat(schema.type) : []
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value
  if (types.length && !types.some((type) => type === actual || (type === "integer" && Number.isInteger(value)))) failure(`wrong argument type at ${path}`)
  if (actual === "object") {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) failure(`missing required argument ${path}.${key}`)
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) schemaCheck(entry, schema.properties[key], `${path}.${key}`, root)
      else if (schema.additionalProperties === false) failure(`unknown argument ${path}.${key}`)
      else if (typeof schema.additionalProperties === "object") schemaCheck(entry, schema.additionalProperties, `${path}.${key}`, root)
    }
  }
  if (actual === "array" && schema.items) value.forEach((entry, index) => schemaCheck(entry, schema.items, `${path}[${index}]`, root))
}

export function validateToolCalls(calls, { tools, toolChoice, parallelToolCalls } = {}) {
  const definitions = tools === undefined ? null : new Map(tools.map((entry) => {
    const fn = entry.function ?? entry
    return [fn.name, fn]
  }))
  if ((toolChoice === "required" || toolChoice?.function?.name) && !calls.length) failure("tool_choice requires a tool call")
  if (parallelToolCalls === false && calls.length > 1) failure("parallel calls are disabled for this request")
  const forced = toolChoice?.function?.name
  for (const call of calls) {
    const name = call.function?.name
    if (typeof name !== "string" || !name.trim()) failure("tool name is missing")
    if (definitions && !definitions.has(name)) failure(`unknown tool ${name}`)
    if (toolChoice === "none" || (forced && name !== forced)) failure("tool_choice does not permit this call")
    let args
    try { args = JSON.parse(call.function.arguments) } catch { failure(`invalid arguments for ${name}`) }
    if (!args || typeof args !== "object" || Array.isArray(args)) failure(`arguments for ${name} must be an object`)
    const schema = definitions?.get(name)?.parameters
    if (schema) schemaCheck(args, schema, name, schema)
  }
  return calls
}
