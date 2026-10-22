import test from "node:test"
import assert from "node:assert/strict"
import { scanToolReply, ToolOutputGate, validateToolCalls } from "./tool-protocol.mjs"
import { createOpenAiJsonResponse, createOpenAiStreamResponse } from "./sse.mjs"
import { DeepSeekClient } from "./client.mjs"
import { Conversation } from "./conv.mjs"
import plugin, { _internal } from "./index.mjs"

const tag = (name, pipes = "｜") => `<${name.startsWith("/") ? "/" : ""}${pipes.repeat(2)}DSML${pipes.repeat(2)}${name.replace(/^\//, "")}>`
const invoke = (name, args, pipes = "｜") => tag(`invoke name="${name}"`, pipes) + Object.entries(args).map(([key, value]) =>
  tag(`parameter name="${key}" string="${typeof value === "string"}"`, pipes) + (typeof value === "string" ? value : JSON.stringify(value)) + tag("/parameter", pipes)
).join("") + tag("/invoke", pipes)
const batch = (body, pipes = "｜", envelope = "function_calls") => tag(envelope, pipes) + body + tag(`/${envelope}`, pipes)
const fence = (doc) => "```tool_call\n" + JSON.stringify(doc) + "\n```"
const tools = [
  { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } } },
  { type: "function", function: { name: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } } },
]

function upstream(reply) {
  const data = 'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n' +
    "data: " + JSON.stringify({ v: { response: { fragments: [{ id: 2, type: "RESPONSE", content: reply }] } } }) + "\n\n" +
    "event: close\ndata: {}\n\n"
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(data)); c.close() } })
}

for (const pipes of ["｜", "|"]) {
  test(`DSML ${pipes} parallel calls preserve typed values and multiline content`, () => {
    const content = '\n  import React from "react";\n```tsx\nconst x = "</parameter>";\n```\n\n'
    const reply = "Before " + batch(invoke("bash", { command: 'printf "%s" "a b"' }, pipes) + invoke("write", { path: "ActivityCard.tsx", content }, pipes), pipes, "calls") + " After"
    const parsed = scanToolReply(reply)
    assert.equal(parsed.error, null)
    assert.equal(parsed.cleanText, "Before  After")
    assert.deepEqual(parsed.toolCalls.map((c) => c.function.name), ["bash", "write"])
    assert.equal(JSON.parse(parsed.toolCalls[1].function.arguments).content, content)
    validateToolCalls(parsed.toolCalls, { tools })
    const typed = scanToolReply(batch(invoke("config", { enabled: true, count: 3, list: [1, "x"], missing: null }, pipes), pipes))
    assert.deepEqual(JSON.parse(typed.toolCalls[0].function.arguments), { enabled: true, count: 3, list: [1, "x"], missing: null })
  })
}

test("observed double-bar spaced calls and OMP single-bar tool_calls are compatible", () => {
  for (const marker of ["｜｜", "||", "｜", "|"]) {
    for (const space of ["", " "]) {
      for (const separator of ["", " "]) {
        const spacedMarker = marker.split("").join(separator)
        const t = (s) => `<${s.startsWith("/") ? "/" : ""}${spacedMarker}${separator}DSML${separator}${spacedMarker}${space}${s.replace(/^\//, "")}>`
        const reply = t("tool_calls") + t('invoke name="bash"') + t('parameter name="command"') + "pwd" + t("/parameter") + t("/invoke") + t("/tool_calls")
        const parsed = scanToolReply(reply)
        assert.equal(parsed.error, null, `${marker} ${space} separator=${JSON.stringify(separator)}`)
        assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { command: "pwd" })
      }
    }
  }
})

test("stray DSML closing markers are removed while a separate tool call survives", () => {
  const variants = [
    "</｜｜DSML｜｜ calls>",
    "</||DSML|| calls>",
    "</｜ DSML ｜ function_calls>",
  ]

  for (const closing of variants) {
    const reply = ["说明", closing, "```tool_call", JSON.stringify({ name: "bash", arguments: { command: "pwd" } }), "```"].join("\n")
    const parsed = scanToolReply(reply)
    assert.equal(parsed.error, null)
    assert.equal(parsed.cleanText, "说明\n\n")
    assert.equal(parsed.toolCalls.length, 1)
    assert.equal(parsed.toolCalls[0].function.name, "bash")
    assert.doesNotMatch(parsed.cleanText, /DSML/)
  }
})

test("duplicate DSML parameters invalidate the whole batch instead of overwriting", () => {
  const duplicate = tag("function_calls") + tag('invoke name="bash"') +
    tag('parameter name="command" string="true"') + "first" + tag("/parameter") +
    tag('parameter name="command" string="true"') + "second" + tag("/parameter") + tag("/invoke") + tag("/function_calls")
  const parsed = scanToolReply(duplicate)
  assert.match(parsed.error?.message ?? "", /duplicate DSML parameter/)
  assert.deepEqual(parsed.toolCalls, [])
})

test("every stream split suppresses DSML and keeps surrounding prose", () => {
  const reply = "Before " + batch(invoke("bash", { command: "pwd" })) + " After"
  for (let split = 0; split <= reply.length; split++) {
    const chunks = []
    const gate = new ToolOutputGate((chunk) => chunks.push(chunk))
    gate.push(reply.slice(0, split))
    gate.push(reply.slice(split))
    assert.equal(chunks.length, 0)
    gate.flush()
    assert.equal(chunks.join(""), "Before  After")
  }
})

test("JSON strings preserve whitespace, quotes, XML and embedded Markdown fences", () => {
  const content = '  "quoted"\n```tool_call\n{"example":true}\n```\n</parameter>\n  '
  const parsed = scanToolReply(fence({ name: "write", arguments: { path: "demo.md", content } }))
  assert.equal(parsed.error, null)
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).content, content)
  assert.equal(parsed.cleanText, "")
})

test("large file writes retain every byte through JSON and DSML", () => {
  const content = Array.from({ length: 1200 }, (_, i) => `  // ${i}: 中文 'quotes' \\"double\\" </parameter>\n`).join("") + "```tsx\n// done\n```\n"
  for (const reply of [fence({ name: "write", arguments: { path: "large.tsx", content } }), batch(invoke("write", { path: "large.tsx", content }))]) {
    const parsed = scanToolReply(reply)
    assert.equal(parsed.error, null)
    assert.deepEqual(Buffer.from(JSON.parse(parsed.toolCalls[0].function.arguments).content), Buffer.from(content))
  }
})

test("repeated identical calls are not silently deduplicated", () => {
  const doc = fence({ name: "bash", arguments: { command: "pwd" } })
  const parsed = scanToolReply(doc + "\n" + doc)
  assert.equal(parsed.toolCalls.length, 2)
  assert.notEqual(parsed.toolCalls[0].id, parsed.toolCalls[1].id)
})

for (const streaming of [false, true]) {
  test(`loader ${streaming ? "stream" : "JSON"} corrects malformed calls once and rolls back on a second failure`, async () => {
    const completion = DeepSeekClient.prototype.completion
    const createSession = DeepSeekClient.prototype.createSession
    try {
      for (const correctSecond of [true, false]) {
        const turns = []
        const sessionId = `fixture-${streaming}-${correctSecond}`
        DeepSeekClient.prototype.createSession = async () => sessionId
        DeepSeekClient.prototype.completion = async (input) => {
          turns.push(input)
          const reply = turns.length > 1 && correctSecond
            ? fence({ name: "bash", arguments: { command: "pwd" } })
            : batch(invoke("bash", { command: "pwd", content: "wrong tool" }))
          return new Response(upstream(reply))
        }
        const hooks = await plugin({ client: {} })
        const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "synthetic-token" }))
        const response = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", {
          method: "POST", body: JSON.stringify({ model: "deepseek-chat", stream: streaming, messages: [{ role: "user", content: `fixture ${sessionId}` }], tools }),
        })
        const text = await response.text()
        assert.equal(turns.length, 2, "only one upstream-only correction")
        assert.equal(turns[1].parentMessageId, 2)
        assert.match(turns[1].prompt, /No tools .* were executed/)
        assert.match(turns[1].prompt, /"additionalProperties": false/)
        assert.match(turns[1].prompt, /"required": \[\s*"command"/)
        assert.match(turns[1].prompt, /"name": "write"/)
        if (correctSecond) {
          assert.match(text, /"tool_calls"/)
          assert.doesNotMatch(text, /invalid_tool_call|wrong tool|DSML/)
          const conv = _internal.convStore.getBySession(sessionId)
          assert.ok(conv?.hasParent)
          _internal.convStore.remove(sessionId, conv)
        } else {
          assert.match(text, /invalid_tool_call/)
          assert.doesNotMatch(text, /"tool_calls":\[|"finish_reason":"stop"/)
          assert.equal(_internal.convStore.getBySession(sessionId), undefined)
        }
      }
    } finally {
      DeepSeekClient.prototype.completion = completion
      DeepSeekClient.prototype.createSession = createSession
    }
  })
}

test("JSON upstream disconnects release the conversation for the next request", { timeout: 3000 }, async () => {
  const completion = DeepSeekClient.prototype.completion
  const createSession = DeepSeekClient.prototype.createSession
  try {
    for (const failDuringRepair of [false, true]) {
      const sessionId = `fixture-disconnect-${failDuringRepair}`
      const conv = new Conversation({ sessionId, token: "synthetic-token" })
      conv.commitTurn(41)
      _internal.convStore.register(null, conv)
      let turns = 0
      DeepSeekClient.prototype.createSession = async () => { throw new Error("existing session expected") }
      DeepSeekClient.prototype.completion = async (input) => {
        turns++
        if (failDuringRepair && turns === 1) {
          return new Response(upstream(batch(invoke("bash", { command: "pwd", content: "wrong tool" }))))
        }
        if (turns === (failDuringRepair ? 2 : 1)) {
          return new Response(new ReadableStream({
            start(controller) { controller.error(new Error("fixture upstream disconnected")) },
          }))
        }
        assert.equal(input.parentMessageId, 41, "retry branches from the last committed turn")
        return new Response(upstream(fence({ name: "bash", arguments: { command: "pwd" } })))
      }
      const hooks = await plugin({ client: {} })
      const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "synthetic-token" }))
      const request = () => loaded.fetch("https://chat.deepseek.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "deepseek-chat", stream: false, conversation_id: sessionId, messages: [{ role: "user", content: "fixture disconnect" }], tools }),
      })
      try {
        const failed = await request()
        assert.equal(failed.status, 502)
        assert.match(await failed.text(), /fixture upstream disconnected/)
        assert.equal(conv.parentMessageId, 41)
        assert.equal(conv.turn, 1)
        const resumed = await request()
        assert.equal(resumed.status, 200)
        assert.equal((await resumed.json()).choices[0].finish_reason, "tool_calls")
        assert.equal(conv.turn, 2)
        assert.equal(turns, failDuringRepair ? 3 : 2)
      } finally {
        _internal.convStore.remove(sessionId, conv)
      }
    }
  } finally {
    DeepSeekClient.prototype.completion = completion
    DeepSeekClient.prototype.createSession = createSession
  }
})

const invalid = [
  batch(invoke("", { command: "pwd" })),
  batch(invoke("bash", { command: "pwd" })).slice(0, -5),
  tag("function_calls") + tag('invoke name="bash"') + tag('parameter name="command" string="true"') + "pwd",
  fence({ name: " ", arguments: {} }),
  fence({ name: "bash", arguments: "not json" }),
  '```tool_call\n{"name":"write","arguments":{"content":"half',
  "```tool_call\nnot json\n```",
  "```tool_call_base64\neyJuYW1lIjoiYmFzaCJ9\n```",
]
for (const [index, reply] of invalid.entries()) {
  test(`malformed call ${index} fails the entire batch`, () => {
    const parsed = scanToolReply(fence({ name: "bash", arguments: { command: "pwd" } }) + reply)
    assert.equal(parsed.error?.code, "invalid_tool_call")
    assert.deepEqual(parsed.toolCalls, [])
  })
}

test("tool allowlist, required arguments, types, extras and tool choice are enforced", () => {
  for (const doc of [
    { name: "missing", arguments: {} },
    { name: "bash", arguments: {} },
    { name: "bash", arguments: { command: 42 } },
    { name: "bash", arguments: { command: "pwd", content: "misrouted file content" } },
  ]) {
    assert.throws(() => validateToolCalls(scanToolReply(fence(doc)).toolCalls, { tools }), /Invalid tool call/)
  }
  const calls = scanToolReply(batch(invoke("bash", { command: "pwd" }) + invoke("write", { path: "x", content: "x" }))).toolCalls
  assert.throws(() => validateToolCalls(calls, { tools, parallelToolCalls: false }), /parallel/)
  assert.throws(() => validateToolCalls(calls, { tools, toolChoice: { type: "function", function: { name: "bash" } } }), /tool_choice/)
})

test("stray DSML closing markers are removed while a separate tool call survives", () => {
  const variants = [
    "</｜｜DSML｜｜ calls>",
    "</||DSML|| calls>",
    "</｜ DSML ｜ function_calls>",
  ]

  for (const closing of variants) {
    const reply = ["说明", closing, "```tool_call", JSON.stringify({ name: "bash", arguments: { command: "pwd" } }), "```"].join("\n")
    const parsed = scanToolReply(reply)
    assert.equal(parsed.error, null)
    assert.equal(parsed.cleanText, "说明\n\n")
    assert.equal(parsed.toolCalls.length, 1)
    assert.equal(parsed.toolCalls[0].function.name, "bash")
    assert.doesNotMatch(parsed.cleanText, /DSML/)
  }
})

for (const streaming of [false, true]) {
  test(`${streaming ? "stream" : "JSON"} returns both DSML calls without raw markup`, async () => {
    const reply = "Before " + batch(invoke("bash", { command: "pwd" }) + invoke("write", { path: "x", content: "  x\n" })) + " After"
    const create = streaming ? createOpenAiStreamResponse : createOpenAiJsonResponse
    const response = await create({ upstreamStream: upstream(reply), completionId: "test", modelName: "deepseek-chat", createdAt: 1, hasTools: true, tools })
    if (!streaming) {
      const result = await response.json()
      assert.equal(result.choices[0].finish_reason, "tool_calls")
      assert.equal(result.choices[0].message.content, "Before  After")
      assert.equal(result.choices[0].message.tool_calls.length, 2)
    } else {
      const text = await response.text()
      assert.ok(!text.includes("DSML"))
      const chunks = text.split("\n\n").filter((s) => s.startsWith("data: ") && s !== "data: [DONE]").map((s) => JSON.parse(s.slice(6)))
      const calls = chunks.flatMap((c) => c.choices?.[0].delta.tool_calls ?? [])
      assert.deepEqual(calls.map((c) => c.index), [0, 1])
      assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls")
    }
  })

  test(`${streaming ? "stream" : "JSON"} reports invalid batch without calls or successful stop and rolls back`, async () => {
    for (const reply of [batch(invoke("bash", { command: "pwd", content: "wrong tool" })), invalid[2]]) {
      const create = streaming ? createOpenAiStreamResponse : createOpenAiJsonResponse
      let failed = false
      const response = await create({ upstreamStream: upstream(reply), completionId: "test", modelName: "deepseek-chat", createdAt: 1, hasTools: true, tools, onFinish: (_total, _reply, _calls, _shown, error) => { failed = error } })
      const text = await response.text()
      assert.equal(failed, true)
      assert.match(text, /invalid_tool_call/)
      assert.doesNotMatch(text, /<[^>]*DSML|wrong tool|"finish_reason":"stop"|"tool_calls":\[/)
      if (!streaming) assert.equal(response.status, 502)
    }
  })
}
