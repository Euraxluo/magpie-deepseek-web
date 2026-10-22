import test from "node:test"
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { solvePow, deepSeekHashV1, buildPowResponseHeader } from "./pow.mjs"
import { resolveModel, MODELS } from "./models.mjs"
import { normalizeUserToken, decodeJwtClaims } from "./auth.mjs"
import {
  calculatePrefixKey,
  contentFingerprint,
  extractText,
  extractImages,
  Conversation,
  ConversationStore,
} from "./conv.mjs"
import {
  readDeepSeekSseStream,
  createOpenAiJsonResponse,
  createOpenAiStreamResponse,
  turnUsage,
} from "./sse.mjs"

const sseText = (frames) => frames.join("")

function streamOf(text) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text))
      c.close()
    },
  })
}

async function readAll(res) {
  const text = await res.text()
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice("data: ".length))
}

test("DeepSeekHashV1 matches the vectors captured from the web client", () => {
  assert.equal(
    deepSeekHashV1(Buffer.from("a40318e6b7af56bf27cf_1790959021012_58595")),
    "168efa309e5a73033fc82dde4333bbc6515da440ef961574f73f99cbe7b397ad"
  )
  assert.equal(
    deepSeekHashV1(Buffer.from("0b846826f9b7ab6000f6_1790959592240_44460")),
    "ab9178c48249ac301272e3e24b9a5aef207e593add3003bfd7a8fb8abb572079"
  )
})

test("POW solver finds the nonce the web client found", async () => {
  const solved = await solvePow({
    algorithm: "DeepSeekHashV1",
    challenge: "168efa309e5a73033fc82dde4333bbc6515da440ef961574f73f99cbe7b397ad",
    salt: "a40318e6b7af56bf27cf",
    expire_at: 1790959021012,
    signature: "sig",
    target_path: "/api/v0/chat/completion",
  })
  assert.equal(solved.answer, 58595)

  const header = JSON.parse(Buffer.from(buildPowResponseHeader(solved), "base64").toString("utf8"))
  assert.deepEqual(header, {
    algorithm: "DeepSeekHashV1",
    challenge: "168efa309e5a73033fc82dde4333bbc6515da440ef961574f73f99cbe7b397ad",
    salt: "a40318e6b7af56bf27cf",
    answer: 58595,
    signature: "sig",
    target_path: "/api/v0/chat/completion",
  })
})

test("POW solver rejects a challenge it cannot read", async () => {
  await assert.rejects(solvePow({ challenge: "zz", salt: "s", expire_at: 1 }))
  await assert.rejects(solvePow({ algorithm: "Other", challenge: "00", salt: "s", expire_at: 1 }))
})

test("normalizeUserToken takes the token out of what the browser stores", () => {
  const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.sig"
  assert.equal(normalizeUserToken(token), token)
  assert.equal(normalizeUserToken(`Bearer ${token}`), token)
  assert.equal(normalizeUserToken(`"${token}"`), token)
  assert.equal(normalizeUserToken(JSON.stringify({ value: token, __version: "0" })), token)
  assert.equal(normalizeUserToken(""), "")
})

test("decodeJwtClaims reads a payload, null for anything else", () => {
  const token = "x." + Buffer.from(JSON.stringify({ email: "a@b.c" })).toString("base64url") + ".y"
  assert.equal(decodeJwtClaims(token)?.email, "a@b.c")
  assert.equal(decodeJwtClaims("not-a-jwt"), null)
})

test("resolveModel exposes one web-session model regardless of the outer name", () => {
  for (const name of ["deepseek-web", "deepseek-chat", "deepseek-v3", "deepseek-r1", "gpt-4o", undefined]) {
    const model = resolveModel(name)
    assert.equal(model.id, "deepseek-web")
    assert.equal(model.thinking, false)
    assert.equal(model.search, false)
  }
})

test("content fingerprints and prefix keys separate models and images", () => {
  assert.equal(contentFingerprint("hi"), "hi")
  assert.equal(extractText("hi"), "hi")
  assert.equal(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb")
  assert.deepEqual(extractImages([{ type: "text", text: "a" }]), [])
  assert.deepEqual(
    extractImages([{ type: "image_url", image_url: { url: "https://x/y.png" } }]),
    [{ type: "url", url: "https://x/y.png" }]
  )
  assert.deepEqual(
    extractImages([{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]),
    [{ type: "data", data: "AAAA", mime: "image/png", isBase64: true }]
  )

  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ]
  assert.equal(calculatePrefixKey(messages, "deepseek-chat"), calculatePrefixKey(messages, "deepseek-chat"))
  assert.notEqual(calculatePrefixKey(messages, "deepseek-chat"), calculatePrefixKey(messages, "deepseek-reasoner"))
  // a long image is fingerprinted, not kept
  const data = "data:image/png;base64," + "A".repeat(4000)
  const key = calculatePrefixKey([{ role: "user", content: [{ type: "image_url", image_url: { url: data } }] }], "m")
  assert.match(contentFingerprint([{ type: "image_url", image_url: { url: data } }]), /^\[image:[0-9a-f]{16}\]$/)
  assert.equal(key.length, 32)
})

test("conversation store keeps sessions by prefix and id, evicting the oldest", () => {
  const store = new ConversationStore({ maxSize: 2 })
  store.register("k1", { sessionId: "s1", lastUsed: Date.now() - 3000 })
  store.register("k2", { sessionId: "s2", lastUsed: Date.now() - 2000 })
  assert.equal(store.getByPrefix("k1").sessionId, "s1")
  assert.equal(store.getBySession("s2").sessionId, "s2")

  store.register("k3", { sessionId: "s3" })
  assert.equal(store.size, 2)
  assert.equal(store.getBySession("s1"), undefined)
  assert.equal(store.getBySession("s3").sessionId, "s3")
})

test("a conversation runs its turns one at a time", async () => {
  const conv = new Conversation({ sessionId: "s", client: null, token: "t" })
  const order = []
  const first = conv.run(async () => {
    order.push("first-in")
    await new Promise((r) => setTimeout(r, 20))
    order.push("first-out")
  })
  const second = conv.run(async () => {
    order.push("second-in")
  })
  await Promise.all([first, second])
  assert.deepEqual(order, ["first-in", "first-out", "second-in"])

  // acquire holds the conversation until the stream releases it
  const release = await conv.acquire()
  let thirdRan = false
  const third = conv.run(async () => {
    thirdRan = true
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(thirdRan, false)
  release()
  await third
  assert.equal(thirdRan, true)
})

test("usage is this turn's share of the session's cumulative total", () => {
  // first turn: the whole cumulative total
  assert.deepEqual(turnUsage({ accumulated: 74, previous: -1, replyChars: 40 }), {
    usage: { prompt_tokens: 64, completion_tokens: 10, total_tokens: 74 },
    total: 74,
  })
  // second turn: the difference
  assert.deepEqual(turnUsage({ accumulated: 120, previous: 74, replyChars: 40 }), {
    usage: { prompt_tokens: 36, completion_tokens: 10, total_tokens: 46 },
    total: 120,
  })
  // no usage frame: the reply's length stands in for it
  assert.deepEqual(turnUsage({ accumulated: -1, previous: -1, replyChars: 40 }), {
    usage: { prompt_tokens: 0, completion_tokens: 10, total_tokens: 10 },
    total: -1,
  })
})

test("the stream parser follows the patch protocol", async () => {
  const text = sseText([
    "event: ready\ndata: {\"request_message_id\":100,\"response_message_id\":200}\n\n",
    "event: update_session\ndata: {\"updated_at\":1}\n\n",
    'data: {"v":{"response":{"fragments":[{"id":200,"type":"THINK","content":"Thinking."}]}}}\n\n',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" More."}\n\n',
    'data: {"p":"response/fragments","o":"APPEND","v":[{"id":201,"type":"RESPONSE","content":"Hello"}]}\n\n',
    'data: {"v":" world"}\n\n',
    'data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":0.6}\n\n',
    'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":74}]}\n\n',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    "event: title\ndata: {\"content\":\"a title\"}\n\n",
    "event: close\ndata: {\"click_behavior\":\"none\"}\n\n",
  ])

  let ready = null
  let close = 0
  let usage = -1
  const think = []
  const reply = []
  await readDeepSeekSseStream(streamOf(text), {
    onReady: (req, resp) => (ready = [req, resp]),
    onDelta: (type, text) => (type === "THINK" ? think : reply).push(text),
    onUsage: (n) => (usage = n),
    onClose: () => close++,
  })

  assert.deepEqual(ready, [100, 200])
  assert.equal(think.join(""), "Thinking. More.")
  assert.equal(reply.join(""), "Hello world")
  assert.equal(usage, 74)
  assert.equal(close, 1)
})

test("a non-streaming reply carries content, reasoning and usage", async () => {
  const text = sseText([
    "event: ready\ndata: {\"request_message_id\":1,\"response_message_id\":2}\n\n",
    'data: {"v":{"response":{"fragments":[{"id":2,"type":"THINK","content":"Plan."}]}}}\n\n',
    'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"Done."}]}\n\n',
    'data: {"p":"response/accumulated_token_usage","v":50}\n\n',
    "event: close\ndata: {}\n\n",
  ])

  let finished = null
  const res = await createOpenAiJsonResponse({
    upstreamStream: streamOf(text),
    completionId: "chatcmpl-1",
    modelName: "deepseek-reasoner",
    createdAt: 1700000000,
    onFinish: (total, reply) => (finished = { total, reply }),
  })
  const json = await res.json()

  assert.equal(json.object, "chat.completion")
  assert.equal(json.model, "deepseek-reasoner")
  assert.equal(json.choices[0].message.content, "Done.")
  assert.equal(json.choices[0].message.reasoning_content, "Plan.")
  assert.equal(json.choices[0].finish_reason, "stop")
  assert.equal(json.usage.total_tokens, 50)
  assert.deepEqual(finished, { total: 50, reply: "Done." })
})

test("a streamed reply sends deltas, a stop chunk and [DONE]", async () => {
  const text = sseText([
    "event: ready\ndata: {\"request_message_id\":1,\"response_message_id\":2}\n\n",
    'data: {"v":{"response":{"fragments":[{"id":2,"type":"THINK","content":"Plan."}]}}}\n\n',
    'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"Done."}]}\n\n',
    'data: {"v":" More"}\n\n',
    'data: {"p":"response/accumulated_token_usage","v":50}\n\n',
    "event: close\ndata: {}\n\n",
  ])

  let sessionReady = null
  let finished = null
  const res = await createOpenAiStreamResponse({
    upstreamStream: streamOf(text),
    completionId: "chatcmpl-2",
    modelName: "deepseek-reasoner",
    createdAt: 1700000000,
    previousUsage: 20,
    streamOptions: { include_usage: true },
    onSessionReady: (req, resp) => (sessionReady = [req, resp]),
    onFinish: (total, reply) => (finished = { total, reply }),
  })
  assert.match(res.headers.get("content-type"), /text\/event-stream/)

  const data = await readAll(res)
  assert.equal(data.at(-1), "[DONE]")

  const chunks = data.slice(0, -1).map((d) => JSON.parse(d))
  const deltas = chunks.map((c) => c.choices[0].delta)
  assert.equal(deltas[0].role, "assistant")
  assert.equal(deltas[0].reasoning_content, "Plan.")
  assert.equal(deltas[1].content, "Done.")
  assert.equal(deltas[2].content, " More")
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop")
  // turn 2 of the session: 50 cumulative − 20 before
  assert.equal(chunks.at(-1).usage.total_tokens, 30)
  assert.deepEqual(sessionReady, [1, 2])
  assert.equal(finished.total, 50)
  assert.equal(finished.reply, "Done. More")
})

test("the plugin offers the hooks OpenCode and magpie load", async () => {
  const { default: plugin } = await import("./index.mjs")
  const hooks = await plugin({ client: { auth: { set: async () => {} } } })

  assert.equal(typeof hooks.config, "function")
  assert.equal(hooks.auth.provider, "deepseek-web")
  assert.equal(typeof hooks.auth.loader, "function")
  assert.deepEqual(
    hooks.auth.methods.map((m) => m.type),
    ["oauth", "api"]
  )

  const config = { provider: {} }
  await hooks.config(config)
  const p = config.provider["deepseek-web"]
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.deepEqual(Object.keys(p.models).sort(), Object.keys(MODELS).sort())
})

test("the loader serves /models itself and turns other paths away", async () => {
  const { default: plugin } = await import("./index.mjs")
  const hooks = await plugin({ client: {} })
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "tok" }))
  assert.equal(loaded.baseURL, "https://chat.deepseek.com/v1")

  const models = await (await loaded.fetch("https://chat.deepseek.com/v1/models", { method: "GET" })).json()
  assert.deepEqual(models.data.map((m) => m.id).sort(), Object.keys(MODELS).sort())

  const missing = await loaded.fetch("https://chat.deepseek.com/v1/embeddings", { method: "POST", body: "{}" })
  assert.equal(missing.status, 404)
  assert.match((await missing.json()).error.message, /POST \/v1\/embeddings/)

  const bad = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-chat" }),
  })
  assert.equal(bad.status, 400)
})

test("upstream failures are said in OpenAI's error shape", async () => {
  const { _internal } = await import("./index.mjs")
  const { DeepSeekError } = await import("./client.mjs")

  // DeepSeek answers a bad sign-in with its own envelope codes, not HTTP 401
  assert.equal(_internal.mapUpstreamError(new DeepSeekError("x", 400, 40003)).status, 401)
  assert.equal(_internal.mapUpstreamError(new DeepSeekError("x", 200, 40002)).status, 401)
  assert.equal(_internal.mapUpstreamError(new DeepSeekError("x", 429, 0)).status, 429)
  assert.equal(_internal.mapUpstreamError(new DeepSeekError("x", 500, 0)).status, 502)
  assert.equal(_internal.mapUpstreamError(new Error("boom")).status, 502)
})

test("no token means no loader config", async () => {
  const { default: plugin } = await import("./index.mjs")
  const hooks = await plugin({ client: {} })
  assert.deepEqual(await hooks.auth.loader(async () => null), {})
  assert.deepEqual(await hooks.auth.loader(async () => ({ type: "api", key: "" })), {})
})

test("a JSON tool call in a streamed reply becomes tool_calls, and the fence never reaches content", async () => {
  const doc = JSON.stringify({ name: "run_command", arguments: { command: "ls -la" } })
  const firstDelta = `Let me check.\n\n\`\`\`tool_call\n${doc.slice(0, 18)}`
  const text = sseText([
    "event: ready\ndata: {\"request_message_id\":1,\"response_message_id\":2}\n\n",
    "data: " + JSON.stringify({ v: { response: { fragments: [{ id: 2, type: "RESPONSE", content: firstDelta }] } } }) + "\n\n",
    "data: " + JSON.stringify({ v: `${doc.slice(18)}\n\`\`\`` }) + "\n\n",
    'data: {"p":"response/accumulated_token_usage","v":60}\n\n',
    "event: close\ndata: {}\n\n",
  ])

  let finished = null
  const res = await createOpenAiStreamResponse({
    upstreamStream: streamOf(text),
    completionId: "chatcmpl-t1",
    modelName: "deepseek-chat",
    createdAt: 1700000000,
    hasTools: true,
    onFinish: (total, reply, calls) => (finished = { total, reply, calls }),
  })

  const data = await readAll(res)
  assert.equal(data.at(-1), "[DONE]")
  const chunks = data.slice(0, -1).map((d) => JSON.parse(d))
  const content = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")
  assert.equal(content, "Let me check.\n\n")
  assert.ok(!content.includes("tool_call"))

  const toolChunk = chunks.find((c) => c.choices[0]?.delta?.tool_calls)
  assert.ok(toolChunk)
  const call = toolChunk.choices[0].delta.tool_calls[0]
  assert.equal(call.type, "function")
  assert.equal(call.function.name, "run_command")
  assert.deepEqual(JSON.parse(call.function.arguments), { command: "ls -la" })

  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls")
  assert.equal(finished.calls.length, 1)
})

test("multiple streamed JSON fences emit tool_calls indices 0 and 1", async () => {
  const first = JSON.stringify({ name: "run_command", arguments: { command: "pwd" } })
  const second = JSON.stringify({ name: "read_file", arguments: { path: "a.txt" } })
  const block = ["```tool_call", first, "```", "", "```tool_call", second, "```"].join("\n")
  const text = sseText([
    'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n',
    "data: " + JSON.stringify({ v: { response: { fragments: [{ id: 2, type: "RESPONSE", content: block }] } } }) + "\n\n",
    'data: {"p":"response/accumulated_token_usage","v":30}\n\n',
    "event: close\ndata: {}\n\n",
  ])

  const res = await createOpenAiStreamResponse({
    upstreamStream: streamOf(text),
    completionId: "chatcmpl-t-fences",
    modelName: "deepseek-chat",
    createdAt: 1700000000,
    hasTools: true,
  })
  const data = await readAll(res)
  const chunks = data.slice(0, -1).map((d) => JSON.parse(d))
  const toolChunk = chunks.find((chunk) => chunk.choices[0]?.delta?.tool_calls)
  assert.deepEqual(toolChunk.choices[0].delta.tool_calls.map((call) => call.index), [0, 1])
  assert.deepEqual(toolChunk.choices[0].delta.tool_calls.map((call) => call.function.name), ["run_command", "read_file"])
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls")
})

test("a TOML call inside the fence is read, not printed", async () => {
  const block = ["Before", '```tool_call\nname = "run_command"\n[parameters]\ncommand = "pwd"\n```', "After"].join("\n")
  const text = sseText([
    'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n',
    "data: " + JSON.stringify({ v: { response: { fragments: [{ id: 2, type: "RESPONSE", content: block }] } } }) + "\n\n",
    "event: close\ndata: {}\n\n",
  ])

  const res = await createOpenAiStreamResponse({
    upstreamStream: streamOf(text),
    completionId: "chatcmpl-t-legacy",
    modelName: "deepseek-chat",
    createdAt: 1700000000,
    hasTools: true,
  })
  const data = await readAll(res)
  const chunks = data.slice(0, -1).map((d) => JSON.parse(d))
  const content = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? "").join("")
  assert.equal(content, "Before\n\nAfter")
  const toolChunk = chunks.find((chunk) => chunk.choices[0]?.delta?.tool_calls)
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, "run_command")
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls")
})

test("a streamed JSON tool_calls array emits indices 0 and 1", async () => {
  const document = JSON.stringify({
    tool_calls: [
      { id: "call_0", type: "function", function: { name: "run_command", arguments: { command: "pwd" } } },
      { id: "call_1", type: "function", function: { name: "read_file", arguments: { path: "a.txt" } } },
    ],
  })
  const block = `\`\`\`tool_call\n${document}\n\`\`\``
  const text = sseText([
    "event: ready\ndata: {\"request_message_id\":1,\"response_message_id\":2}\n\n",
    "data: " + JSON.stringify({ v: { response: { fragments: [{ id: 2, type: "RESPONSE", content: block }] } } }) + "\n\n",
    'data: {"p":"response/accumulated_token_usage","v":30}\n\n',
    "event: close\ndata: {}\n\n",
  ])

  const res = await createOpenAiStreamResponse({
    upstreamStream: streamOf(text),
    completionId: "chatcmpl-t-array",
    modelName: "deepseek-chat",
    createdAt: 1700000000,
    hasTools: true,
  })
  const data = await readAll(res)
  const chunks = data.slice(0, -1).map((d) => JSON.parse(d))
  const toolChunk = chunks.find((chunk) => chunk.choices[0]?.delta?.tool_calls)
  assert.deepEqual(toolChunk.choices[0].delta.tool_calls.map((call) => call.index), [0, 1])
  assert.deepEqual(toolChunk.choices[0].delta.tool_calls.map((call) => call.function.name), ["run_command", "read_file"])
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls")
})

test("a non-streaming JSON tool call becomes message.tool_calls with finish_reason tool_calls", async () => {
  const document = JSON.stringify({ name: "read_file", arguments: { path: "a.txt" } })
  const block = `\`\`\`tool_call\n${document}\n\`\`\``
  const text = sseText([
    "event: ready\ndata: {\"request_message_id\":1,\"response_message_id\":2}\n\n",
    "data: " + JSON.stringify({ v: { response: { fragments: [{ id: 2, type: "RESPONSE", content: block }] } } }) + "\n\n",
    'data: {"p":"response/accumulated_token_usage","v":30}\n\n',
    "event: close\ndata: {}\n\n",
  ])

  const res = await createOpenAiJsonResponse({
    upstreamStream: streamOf(text),
    completionId: "chatcmpl-t2",
    modelName: "deepseek-chat",
    createdAt: 1700000000,
    hasTools: true,
  })
  const json = await res.json()
  assert.equal(json.choices[0].finish_reason, "tool_calls")
  assert.equal(json.choices[0].message.content, null)
  assert.equal(json.choices[0].message.tool_calls[0].function.name, "read_file")
  assert.deepEqual(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments), { path: "a.txt" })
})

test("a prompt for a fresh session carries JSON tool instructions and anchor", async () => {
  const { _internal } = await import("./index.mjs")
  const tools = [
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    },
  ]
  const { prompt, images } = _internal.buildTurnPrompt({
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "list the files" },
    ],
    tools,
    toolChoice: "auto",
    fresh: true,
  })
  assert.equal(images.length, 0)
  assert.match(prompt, /You are a coding agent\./)
  assert.match(prompt, /```tool_call\n/)
  assert.match(prompt, /System instruction — highest priority/)
  assert.match(prompt, /the ONLY execution channel/)
  assert.match(prompt, /list the files/)
  // the anchor is last, where a web model weights it most
  assert.ok(prompt.indexOf("highest priority") > prompt.indexOf("list the files"))
})

test("after a tool call, the next turn sends the tool result and the tools anchor, not the history", async () => {
  const { _internal } = await import("./index.mjs")
  const tools = [{ type: "function", function: { name: "run_command", parameters: {} } }]
  const messages = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"ls"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", name: "run_command", content: "Process exited with code 0\nOutput:\na.txt" },
  ]

  const { prompt } = _internal.buildTurnPrompt({ messages, tools, toolChoice: "auto", fresh: false })
  assert.match(prompt, /Tool result for run_command/)
  assert.match(prompt, /a\.txt/)
  assert.ok(!prompt.includes("list the files"), "history belongs to the upstream session, not this turn")
  assert.match(prompt, /highest priority/)
})

test("an empty stop replayed as history does not drop the pending tool result", async () => {
  const { _internal } = await import("./index.mjs")
  const tools = [{ type: "function", function: { name: "run_command", parameters: {} } }]
  // A client retries an empty stop by appending an assistant turn with no text
  // and no calls. That turn must not become the split point, or the retry sends
  // the anchor alone and the model restarts from nothing.
  const messages = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"ls"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", name: "run_command", content: "a.txt" },
    { role: "assistant", content: "" },
  ]

  const { prompt } = _internal.buildTurnPrompt({ messages, tools, toolChoice: "auto", fresh: false })
  assert.match(prompt, /Tool result for run_command/)
  assert.match(prompt, /a\.txt/, "the retry still carries what the tool said")
})

test("a whitespace-only assistant turn is not a split point either", async () => {
  const { _internal } = await import("./index.mjs")
  const tools = [{ type: "function", function: { name: "run_command", parameters: {} } }]
  const messages = [
    { role: "system", content: "agent" },
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c", type: "function", function: { name: "run_command", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c", name: "run_command", content: "a.txt" },
    { role: "assistant", content: "\n\n  " },
  ]
  const { prompt } = _internal.buildTurnPrompt({ messages, tools, toolChoice: "auto", fresh: false })
  assert.match(prompt, /a\.txt/)
})

test("a fresh session rebuilds prior tool calls as JSON blocks", async () => {
  const { _internal } = await import("./index.mjs")
  const tools = [{ type: "function", function: { name: "run_command", parameters: {} } }]
  const messages = [
    { role: "system", content: "agent" },
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"ls"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", name: "run_command", content: "a.txt" },
    { role: "user", content: "now read a.txt" },
  ]
  const { prompt } = _internal.buildTurnPrompt({ messages, tools, toolChoice: "auto", fresh: true })
  assert.match(prompt, /```tool_call\n\{"name":"run_command","arguments":\{"command":"ls"\}\}\n```/)
  assert.match(prompt, /Tool result for run_command/)
  assert.match(prompt, /now read a\.txt/)
})

test("prefix keys ignore id and shape differences in tool calls", () => {
  const a = [
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: '{"a":1,"b":2}' } }] },
  ]
  const b = [
    { role: "assistant", content: null, tool_calls: [{ function: { name: "x", arguments: { b: 2, a: 1 } } }] },
  ]
  assert.equal(calculatePrefixKey(a, "m"), calculatePrefixKey(b, "m"))
})

test("a parallel tool round continues the same upstream session", async () => {
  const { _internal } = await import("./index.mjs")
  _internal.convStore.clear?.()

  const tools = [{ type: "function", function: { name: "read" } }]
  const firstTurn = [
    { role: "system", content: "agent" },
    { role: "user", content: "read both" },
  ]

  // What the plugin registers after its first turn: the call it showed the
  // client, with empty prose.
  const shownCalls = [
    { index: 0, id: "call_a", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
    { index: 1, id: "call_b", type: "function", function: { name: "read", arguments: '{"path":"b"}' } },
  ]

  // What the client sends back: the same calls in its own shape, plus one
  // tool result per call — two new messages, not one.
  const nextTurn = [
    ...firstTurn,
    {
      role: "assistant",
      content: "\n\n",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "read", arguments: { path: "a" } } },
        { id: "call_b", type: "function", function: { name: "read", arguments: { path: "b" } } },
      ],
    },
    { role: "tool", tool_call_id: "call_a", name: "read", content: "A" },
    { role: "tool", tool_call_id: "call_b", name: "read", content: "B" },
  ]

  const key = calculatePrefixKey([...firstTurn, { role: "assistant", content: "", tool_calls: shownCalls }], "deepseek-chat")
  const conv = { sessionId: "sess-parallel", token: "tok", lastUsed: Date.now() }
  _internal.convStore.register(key, conv)

  let created = 0
  const client = { createSession: async () => (created++, { id: "new" }) }
  const found = await _internal.conversationFor({
    messages: nextTurn,
    modelId: "deepseek-chat",
    client,
    token: "tok",
  })
  assert.equal(found.fresh, false, "the parallel round continues the session the first turn opened")
  assert.equal(found.conv.sessionId, "sess-parallel")
  assert.equal(created, 0)
  _internal.convStore.clear?.()
})

test("the loader turns a tools request into a JSON prompt upstream and tool_calls back", async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.endsWith("/api/v0/chat/create_pow_challenge")) {
      // the same vector the solver tests use
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            biz_data: {
              challenge: {
                algorithm: "DeepSeekHashV1",
                challenge: "168efa309e5a73033fc82dde4333bbc6515da440ef961574f73f99cbe7b397ad",
                salt: "a40318e6b7af56bf27cf",
                expire_at: 1790959021012,
                signature: "sig",
                target_path: "/api/v0/chat/completion",
              },
            },
          },
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    }
    if (u.endsWith("/api/v0/chat_session/create")) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: "sess-1" } } } }), {
        headers: { "Content-Type": "application/json" },
      })
    }
    if (u.endsWith("/api/v0/chat/completion")) {
      const block = `\`\`\`tool_call\n${JSON.stringify({ name: "run_command", arguments: { command: "ls -la" } })}\n\`\`\``
      const sse = [
        "event: ready\ndata: {\"request_message_id\":1,\"response_message_id\":2}\n\n",
        "data: " + JSON.stringify({ v: { response: { fragments: [{ id: 2, type: "RESPONSE", content: block }] } } }) + "\n\n",
        'data: {"p":"response/accumulated_token_usage","v":40}\n\n',
        "event: close\ndata: {}\n\n",
      ].join("")
      return new Response(streamOf(sse), { headers: { "Content-Type": "text/event-stream" } })
    }
    return new Response("not found", { status: 404 })
  }

  try {
    const { default: plugin, _internal } = await import("./index.mjs")
    _internal.convStore.clear?.()
    const hooks = await plugin({ client: {} }, { toolFormat: "toml" })
    const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "tok" }))

    const res = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-chat",
        stream: false,
        messages: [{ role: "user", content: "list the files" }],
        tools: [
          {
            type: "function",
            function: {
              name: "run_command",
              description: "Run a shell command",
              parameters: { type: "object", properties: { command: { type: "string" } } },
            },
          },
        ],
      }),
    })

    const json = await res.json()
    assert.equal(json.choices[0].finish_reason, "tool_calls")
    assert.equal(json.choices[0].message.tool_calls[0].function.name, "run_command")
    assert.deepEqual(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments), { command: "ls -la" })

    const upstream = calls.find((c) => c.url.endsWith("/api/v0/chat/completion"))
    const body = JSON.parse(upstream.init.body)
    assert.equal(body.model_type, null)
    assert.equal(body.thinking_enabled, false)
    assert.equal(body.search_enabled, false)
    assert.match(body.prompt, /```tool_call\n/)
    assert.doesNotMatch(body.prompt, /CRITICAL INSTRUCTION: Tool calls MUST be formatted/)
    assert.match(body.prompt, /highest priority/)
    assert.match(body.prompt, /run_command/)
    assert.equal(body.session_id, undefined)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("the loader always asks for JSON and parses it back", async () => {
  const calls = []
  const realFetch = globalThis.fetch
  const document = JSON.stringify({ name: "run_command", arguments: { command: "ls -la" } })

  globalThis.fetch = async (url, init) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.endsWith("/api/v0/chat/create_pow_challenge")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            biz_data: {
              challenge: {
                algorithm: "DeepSeekHashV1",
                challenge: "168efa309e5a73033fc82dde4333bbc6515da440ef961574f73f99cbe7b397ad",
                salt: "a40318e6b7af56bf27cf",
                expire_at: 1790959021012,
                signature: "sig",
                target_path: "/api/v0/chat/completion",
              },
            },
          },
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    }
    if (u.endsWith("/api/v0/chat_session/create")) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: "sess-json" } } } }), {
        headers: { "Content-Type": "application/json" },
      })
    }
    if (u.endsWith("/api/v0/chat/completion")) {
      const sse = [
        "event: ready\ndata: {\"request_message_id\":1,\"response_message_id\":2}\n\n",
        `data: ${JSON.stringify({
          v: {
            response: {
              fragments: [{ id: 2, type: "RESPONSE", content: "On it.\n```tool_call\n" + document + "\n```" }],
            },
          },
        })}\n\n`,
        'data: {"p":"response/accumulated_token_usage","v":40}\n\n',
        "event: close\ndata: {}\n\n",
      ].join("")
      return new Response(streamOf(sse), { headers: { "Content-Type": "text/event-stream" } })
    }
    return new Response("not found", { status: 404 })
  }

  try {
    const { default: plugin } = await import("./index.mjs")
    const hooks = await plugin({ client: {} }, { toolFormat: "json" })
    const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "tok" }))

    const res = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-chat",
        stream: true,
        messages: [{ role: "user", content: "list the files" }],
        tools: [
          { type: "function", function: { name: "run_command", parameters: { type: "object" } } },
        ],
      }),
    })

    const data = (await res.text())
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => b.slice(6))
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d))
    const content = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")
    assert.equal(content, "On it.\n", "the tool fence never reaches the content stream")

    const toolChunk = chunks.find((c) => c.choices[0]?.delta?.tool_calls)
    assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, "run_command")
    assert.deepEqual(JSON.parse(toolChunk.choices[0].delta.tool_calls[0].function.arguments), { command: "ls -la" })
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls")

    const prompt = JSON.parse(calls.find((c) => c.url.endsWith("/api/v0/chat/completion")).init.body).prompt
    assert.match(prompt, /```tool_call\n/)
    assert.ok(!prompt.includes("Base64"), "no encoded format is asked for")
    assert.ok(!prompt.includes("parameters in TOML format"), "the TOML format is not asked for")
  } finally {
    globalThis.fetch = realFetch
  }
})

function powFetch(completions) {
  let n = 0
  const calls = []
  const fetch = async (url, init) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.endsWith("/api/v0/chat/create_pow_challenge")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            biz_data: {
              challenge: {
                algorithm: "DeepSeekHashV1",
                challenge: "168efa309e5a73033fc82dde4333bbc6515da440ef961574f73f99cbe7b397ad",
                salt: "a40318e6b7af56bf27cf",
                expire_at: 1790959021012,
                signature: "sig",
                target_path: "/api/v0/chat/completion",
              },
            },
          },
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    }
    if (u.endsWith("/api/v0/chat_session/create")) {
      n += 1
      return new Response(
        JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: `sess-${n}` } } } }),
        { headers: { "Content-Type": "application/json" } }
      )
    }
    if (u.endsWith("/api/v0/chat_session/delete")) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: {} } }), {
        headers: { "Content-Type": "application/json" },
      })
    }
    if (u.endsWith("/api/v0/chat/completion")) {
      const body = JSON.parse(init.body)
      const next = completions.shift()
      if (!next) throw new Error(`unexpected completion on ${body.chat_session_id}`)
      if (next.throw) throw next.throw
      const reply = typeof next === "function" ? next(body) : next
      const fragments = []
      if (reply.think) fragments.push({ id: 1, type: "THINK", content: reply.think })
      if (reply.text) fragments.push({ id: 2, type: "RESPONSE", content: reply.text })
      const frames = [
        `event: ready\ndata: ${JSON.stringify({ request_message_id: 1, response_message_id: reply.id })}
\n`,
      ]
      if (reply.hint) {
        frames.push(
          `event: hint\ndata: ${JSON.stringify({ type: "error", content: reply.hint, finish_reason: "rate_limit_reached" })}\n\n`
        )
      }
      if (fragments.length > 0) {
        frames.push(`data: ${JSON.stringify({ v: { response: { fragments } } })}\n\n`)
      }
      frames.push('data: {"p":"response/accumulated_token_usage","v":40}\n\n')
      frames.push("event: close\ndata: {}\n\n")
      return new Response(streamOf(frames.join("")), { headers: { "Content-Type": "text/event-stream" } })
    }
    return new Response("not found", { status: 404 })
  }
  return { calls, fetch, push: (reply) => completions.push(reply) }
}

function completionBodies(calls) {
  return calls
    .filter((c) => c.url.endsWith("/api/v0/chat/completion"))
    .map((c) => JSON.parse(c.init.body))
}

async function loadedPlugin() {
  const { default: plugin, _internal } = await import("./index.mjs")
  _internal.convStore.clear()
  const hooks = await plugin({ client: {} })
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "tok" }))
  return { loaded, _internal }
}

const sayTool = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }]

test("an empty stop is retried once on the same DeepSeek session before the client sees it", async () => {
  const script = powFetch([
    { id: 11, think: "thinking only" },
    { id: 12, text: "the files are a.txt" },
  ])
  const realFetch = globalThis.fetch
  globalThis.fetch = script.fetch
  try {
    const { loaded } = await loadedPlugin()
    const res = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-web",
        stream: false,
        messages: [{ role: "user", content: "list the files" }],
      }),
    })
    const json = await res.json()
    assert.equal(json.choices[0].message.content, "the files are a.txt")
    const sent = completionBodies(script.calls)
    assert.equal(sent.length, 2)
    assert.equal(sent[0].chat_session_id, sent[1].chat_session_id)
    assert.equal(sent[1].parent_message_id, null, "the retry branches from the previous node, not the empty one")
    assert.equal(script.calls.filter((c) => c.url.endsWith("/api/v0/chat_session/create")).length, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("a session that stays empty opens a new DeepSeek chat and resends the history", async () => {
  const history = [
    { role: "system", content: "You edit LittleSprout." },
    { role: "user", content: "read WorldView" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"WorldView.tsx"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", name: "read_file", content: "export default function WorldView() {}" },
  ]
  const script = powFetch([
    { id: 21, text: "```tool_call\n" + JSON.stringify({ name: "read_file", arguments: { path: "WorldView.tsx" } }) + "\n```" },
    { id: 31, think: "nothing" },
    { id: 32, think: "still nothing" },
    (body) => {
      assert.match(body.prompt, /You edit LittleSprout/)
      assert.match(body.prompt, /export default function WorldView/)
      assert.equal(body.parent_message_id, null)
      return { id: 41, text: "WorldView now uses the species emoji." }
    },
  ])
  const realFetch = globalThis.fetch
  globalThis.fetch = script.fetch
  try {
    const { loaded } = await loadedPlugin()
    const first = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-web",
        stream: false,
        messages: history.slice(0, 2),
        tools: sayTool,
      }),
    })
    assert.equal((await first.json()).choices[0].finish_reason, "tool_calls")

    const second = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-web", stream: true, messages: history, tools: sayTool }),
    })
    const chunks = (await second.text())
      .split("\n\n")
      .filter((b) => b.startsWith("data: ") && !b.includes("[DONE]"))
      .map((b) => JSON.parse(b.slice(6)))
    const content = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")
    assert.equal(content, "WorldView now uses the species emoji.")

    const sent = completionBodies(script.calls)
    assert.equal(sent[1].chat_session_id, sent[0].chat_session_id)
    assert.equal(sent[2].chat_session_id, sent[0].chat_session_id)
    assert.notEqual(sent[3].chat_session_id, sent[0].chat_session_id)
    assert.ok(!sent[1].prompt.includes("You edit LittleSprout"), "the same session only gets the new turn")
    assert.equal(script.calls.filter((c) => c.url.endsWith("/api/v0/chat_session/delete")).length, 1)

    // The next request of the same chat continues the session that answered.
    script.push({ id: 51, text: "done" })
    const third = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-web",
        stream: false,
        messages: [...history, { role: "assistant", content: "WorldView now uses the species emoji." }, { role: "user", content: "stop" }],
      }),
    })
    assert.equal((await third.json()).choices[0].message.content, "done")
    const continued = completionBodies(script.calls).at(-1)
    assert.equal(continued.chat_session_id, sent[3].chat_session_id)
    assert.equal(continued.parent_message_id, 41)
    assert.ok(!continued.prompt.includes("You edit LittleSprout"), "history stays on the new session")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("a rate limit is not retried by opening another DeepSeek session", async () => {
  const { DeepSeekError } = await import("./client.mjs")
  const script = powFetch([{ throw: new DeepSeekError("limited", 429) }])
  const realFetch = globalThis.fetch
  globalThis.fetch = script.fetch
  try {
    const { loaded } = await loadedPlugin()
    const res = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-web",
        stream: false,
        messages: [{ role: "user", content: "list the files" }],
      }),
    })
    assert.equal(res.status, 429)
    assert.equal(completionBodies(script.calls).length, 1)
    assert.equal(script.calls.filter((c) => c.url.endsWith("/api/v0/chat_session/create")).length, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("a hinted rate limit is reported, not mistaken for an empty turn", async () => {
  // DeepSeek throttles with HTTP 200, then an in-band hint and no reply. Read
  // as an empty turn, it was retried on the same session and then on a new
  // chat, three more requests into a throttle that was still active.
  const script = powFetch([{ id: 61, hint: "消息发送过于频繁，请稍后重试" }])
  const realFetch = globalThis.fetch
  globalThis.fetch = script.fetch
  try {
    const { loaded } = await loadedPlugin()
    const res = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-web",
        stream: false,
        messages: [{ role: "user", content: "list the files" }],
      }),
    })
    assert.equal(res.status, 429)
    assert.match((await res.json()).error.message, /rate limited/)
    assert.equal(completionBodies(script.calls).length, 1, "a throttle is not retried")
    assert.equal(
      script.calls.filter((c) => c.url.endsWith("/api/v0/chat_session/create")).length,
      1,
      "no second chat is opened for it"
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

test("a hint beside a real reply is a notice, not a throttle", async () => {
  const script = powFetch([{ id: 62, text: "a.txt", hint: "slow down" }])
  const realFetch = globalThis.fetch
  globalThis.fetch = script.fetch
  try {
    const { loaded } = await loadedPlugin()
    const res = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-web",
        stream: false,
        messages: [{ role: "user", content: "list the files" }],
      }),
    })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).choices[0].message.content, "a.txt")
    assert.equal(completionBodies(script.calls).length, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})
