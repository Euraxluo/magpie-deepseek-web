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

test("resolveModel maps names, aliases and unknown deepseek ids to a served model", () => {
  assert.equal(resolveModel("deepseek-chat").id, "deepseek-chat")
  assert.equal(resolveModel("deepseek-v3").id, "deepseek-chat")
  assert.equal(resolveModel("deepseek-r1").id, "deepseek-reasoner")
  assert.equal(resolveModel("deepseek-reasoner").thinking, true)
  assert.equal(resolveModel("deepseek-search").search, true)
  assert.equal(resolveModel("deepseek-reasoner-search").thinking, true)
  assert.equal(resolveModel("deepseek-reasoner-search").search, true)
  // a future or renamed id keeps working, as deepseek2api's heuristics do
  assert.equal(resolveModel("deepseek-v4.1-flash").id, "deepseek-chat")
  assert.equal(resolveModel("deepseek-v9-reasoner").id, "deepseek-reasoner")
  assert.equal(resolveModel("deepseek-v9-search-think").id, "deepseek-reasoner-search")
  // anything else is chat, as the proxy's default was
  assert.equal(resolveModel("gpt-4o").id, "deepseek-chat")
  assert.equal(resolveModel(undefined).id, "deepseek-chat")
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
