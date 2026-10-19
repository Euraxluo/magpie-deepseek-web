import test from "node:test"
import assert from "node:assert/strict"
import {
  parseToml,
  parseTomlFallback,
  stringifyToml,
  parseToolCalls,
  normalizeTomlToolCalls,
  ToolFenceGate,
  formatToolCallsToToml,
  formatToolResult,
  buildToolsPrompt,
  buildAnchorPrompt,
  parseToolChoice,
} from "./toml.mjs"

test("pure JS parseTomlFallback parses keys, strings, multiline strings, booleans, numbers, arrays and tables", () => {
  const src = `
name = "write_file"
# comment here
timeout = 42
flag = true
ratio = 3.14
tags = ["fast", "safe", 100]

[parameters]
path = "src/index.js"
content = """
line 1
line 2 with "quotes"
"""
`
  const parsed = parseTomlFallback(src)
  assert.equal(parsed.name, "write_file")
  assert.equal(parsed.timeout, 42)
  assert.equal(parsed.flag, true)
  assert.equal(parsed.ratio, 3.14)
  assert.deepEqual(parsed.tags, ["fast", "safe", 100])
  assert.equal(parsed.parameters.path, "src/index.js")
  assert.equal(parsed.parameters.content, "line 1\nline 2 with \"quotes\"\n")
})

test("parseToml matches Bun.TOML or fallback seamlessly", () => {
  const src = `
name = "run_command"
[parameters]
command = "ls -la"
`
  const obj = parseToml(src)
  assert.equal(obj.name, "run_command")
  assert.equal(obj.parameters.command, "ls -la")

  const fallbackObj = parseTomlFallback(src)
  assert.equal(fallbackObj.name, "run_command")
  assert.equal(fallbackObj.parameters.command, "ls -la")
})

test("stringifyToml converts objects to clean TOML", () => {
  const obj = {
    name: "edit_file",
    parameters: {
      path: "test.txt",
      content: "hello\nworld",
      count: 2,
      enabled: false,
    },
  }
  const toml = stringifyToml(obj)
  assert.match(toml, /name = "edit_file"/)
  assert.match(toml, /\[parameters\]/)
  assert.match(toml, /path = "test.txt"/)
  assert.match(toml, /content = '''/)
  assert.match(toml, /count = 2/)
  assert.match(toml, /enabled = false/)

  // Re-parsing should restore identical object
  const parsed = parseToml(toml)
  assert.equal(parsed.name, "edit_file")
  assert.equal(parsed.parameters.path, "test.txt")
  assert.equal(parsed.parameters.content.trim(), "hello\nworld")
  assert.equal(parsed.parameters.count, 2)
  assert.equal(parsed.parameters.enabled, false)
})

test("parseToolCalls parses ```tool_call blocks and returns cleanText + OpenAI toolCalls", () => {
  const text = `
I will now inspect the project files.

\`\`\`tool_call
name = "list_files"

[parameters]
directory = "./src"
recursive = true
\`\`\`

Let me know if you need more.
`
  const { cleanText, toolCalls } = parseToolCalls(text)
  assert.equal(cleanText, "I will now inspect the project files.\n\nLet me know if you need more.")
  assert.equal(toolCalls.length, 1)
  assert.match(toolCalls[0].id, /^call_[0-9a-f]{16}$/)
  assert.equal(toolCalls[0].type, "function")
  assert.equal(toolCalls[0].function.name, "list_files")
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
    directory: "./src",
    recursive: true,
  })
})

test("parseToolCalls supports multiline strings in TOML tool call parameters without escaping issues", () => {
  const text = `
\`\`\`tool_call toml
name = "execute_script"

[parameters]
script = """
echo "Hello World"
python3 -c 'print("Python inline test")'
"""
\`\`\`
`
  const { toolCalls } = parseToolCalls(text)
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].function.name, "execute_script")
  const args = JSON.parse(toolCalls[0].function.arguments)
  assert.match(args.script, /echo "Hello World"/)
  assert.match(args.script, /python3 -c/)
})

test("parseToolCalls handles multiple tool_call blocks in one response", () => {
  const text = `
\`\`\`tool_call
name = "step1"
[parameters]
val = 1
\`\`\`
Middle text.
\`\`\`tool_call
name = "step2"
[parameters]
val = 2
\`\`\`
`
  const { cleanText, toolCalls } = parseToolCalls(text)
  assert.equal(cleanText, "Middle text.")
  assert.equal(toolCalls.length, 2)
  assert.equal(toolCalls[0].function.name, "step1")
  assert.equal(toolCalls[1].function.name, "step2")
})

test("normalizeTomlToolCalls handles root keys without [parameters] section", () => {
  const parsed = {
    name: "simple_tool",
    path: "foo.txt",
    flag: true,
  }
  const calls = normalizeTomlToolCalls(parsed)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, "simple_tool")
  assert.deepEqual(calls[0].arguments, { path: "foo.txt", flag: true })
})

test("ToolFenceGate gates streaming deltas preventing ```tool_call leaks", () => {
  const emitted = []
  const gate = new ToolFenceGate((chunk) => emitted.push(chunk))

  gate.push("Hello! ")
  gate.push("I will call the tool:\n")
  gate.push("```tool_")
  gate.push("call\nname = \"run\"\n")
  gate.push("[parameters]\ncmd = \"ls\"\n```")
  gate.push("\nEnd of turn.")
  gate.flush()

  assert.equal(emitted.join(""), "Hello! I will call the tool:\n\nEnd of turn.")
})

test("formatToolCallsToToml formats assistant tool_calls into TOML blocks", () => {
  const toolCalls = [
    {
      id: "call_123",
      type: "function",
      function: {
        name: "test_tool",
        arguments: JSON.stringify({ a: 1, b: "multiline\ntext" }),
      },
    },
  ]
  const tomlBlock = formatToolCallsToToml(toolCalls)
  assert.match(tomlBlock, /```tool_call/)
  assert.match(tomlBlock, /name = "test_tool"/)
  assert.match(tomlBlock, /\[parameters\]/)
  assert.match(tomlBlock, /a = 1/)
  assert.match(tomlBlock, /b = '''/)
})

test("formatToolResult handles exit codes and empty results", () => {
  assert.match(
    formatToolResult("bash", "Process exited with code 0\nOutput:\n"),
    /✅ Command succeeded \(exit 0\) with no text output/
  )
  assert.match(
    formatToolResult("bash", "Process exited with code 0\nOutput:\nhello"),
    /✅ Command succeeded \(exit 0\)\. Output:\nhello/
  )
  assert.match(
    formatToolResult("bash", "Process exited with code 1\nOutput:\nerror"),
    /❌ Command failed \(exit 1\)\. Output:\nerror/
  )
  assert.equal(formatToolResult("tool", ""), "[Tool result for tool]: ✅ Command succeeded (exit 0) with no text output. The action is complete; do not re-run it.")
  assert.equal(formatToolResult("tool", "data"), "[Tool result for tool]: data")
})

test("buildToolsPrompt and buildAnchorPrompt enforce TOML format and avoid JSON", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "test_tool",
        description: "A test tool",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    },
  ]
  const prompt = buildToolsPrompt(tools, "auto")
  assert.match(prompt, /CRITICAL INSTRUCTION: Tool calls MUST be formatted as a ```tool_call code block with parameters in TOML format/)
  assert.match(prompt, /DO NOT USE JSON/)
  assert.match(prompt, /\[parameters\]/)

  const anchor = buildAnchorPrompt(tools, "auto")
  assert.match(anchor, /System instruction — highest priority/)
  assert.match(anchor, /output a ```tool_call``` block in TOML format/)
  assert.match(anchor, /parameters MUST ALWAYS be in TOML format, NOT JSON/)
  assert.match(anchor, /name = "test_tool"/)
})

test("parseToolChoice parses string, object and none", () => {
  assert.deepEqual(parseToolChoice("none"), { mode: "none", forced: null })
  assert.deepEqual(parseToolChoice("required"), { mode: "required", forced: null })
  assert.deepEqual(parseToolChoice("auto"), { mode: "auto", forced: null })
  assert.deepEqual(
    parseToolChoice({ type: "function", function: { name: "my_func" } }),
    { mode: "required", forced: "my_func" }
  )
})

test("dotted keys and a JSON fallback still make a call", () => {
  const dotted = parseToolCalls('```tool_call\nname = "run"\nparameters.command = "ls -l"\nparameters.flag = true\n```')
  assert.equal(dotted.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(dotted.toolCalls[0].function.arguments), { command: "ls -l", flag: true })

  // a model that ignores the TOML instruction and writes JSON in the fence
  const json = parseToolCalls('```tool_call\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```')
  assert.equal(json.toolCalls.length, 1)
  assert.equal(json.toolCalls[0].function.name, "read_file")
  assert.deepEqual(JSON.parse(json.toolCalls[0].function.arguments), { path: "a.txt" })
})

test("an unclosed fence is released rather than lost", () => {
  const emitted = []
  const gate = new ToolFenceGate((c) => emitted.push(c))
  gate.push("All done. ")
  gate.push("```tool_call\nname = \"half")
  gate.flush()
  assert.equal(emitted.join(""), "All done. ```tool_call\nname = \"half")
})

test("toml_tool_call fences are gated and parsed too", () => {
  const text = 'Hi\n```toml_tool_call\nname = "x"\n```\nBye'
  const { cleanText, toolCalls } = parseToolCalls(text)
  assert.equal(cleanText, "Hi\n\nBye")
  assert.equal(toolCalls[0].function.name, "x")
})

test("the anchor lists the tool names for a continuing turn", () => {
  const anchor = buildAnchorPrompt(
    [
      { type: "function", function: { name: "run_command" } },
      { type: "function", function: { name: "read_file" } },
    ],
    "auto"
  )
  assert.match(anchor, /Available tools: run_command, read_file\./)
})

// --- base64 tool calls -----------------------------------------------------

import {
  encodeToolCallBase64,
  parseBase64ToolCalls,
  parseBase64ToolCall,
  parseToolCallsAnyFormat,
  looksBase64,
  buildBase64ToolsPrompt,
  buildBase64AnchorPrompt,
  formatToolCallsToBase64,
  resolveToolFormat,
  toolPromptsFor,
} from "./toml.mjs"

const b64Tools = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  },
]

test("a base64 tool call round-trips with its arguments unescaped", () => {
  const args = { command: 'echo "$HOME"\nawk \'{print $1}\' file.txt' }
  const block = encodeToolCallBase64("run_command", args)
  assert.match(block, /^```tool_call_base64\n[A-Za-z0-9+/=]+\n```$/)

  const { cleanText, toolCalls } = parseBase64ToolCalls(`On it.\n\n${block}\n\nDone.`)
  assert.equal(cleanText, "On it.\n\nDone.")
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].type, "function")
  assert.equal(toolCalls[0].function.name, "run_command")
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), args)
  assert.match(toolCalls[0].id, /^call_[0-9a-f]{16}$/)
})

test("base64 blocks survive the line breaks a model adds", () => {
  const encoded = Buffer.from(JSON.stringify({ name: "read_file", arguments: { path: "a b.txt" } })).toString("base64")
  const wrapped = encoded.replace(/(.{16})/g, "$1\n")
  const { toolCalls } = parseBase64ToolCalls("```tool_call_base64\n" + wrapped + "\n```")
  assert.equal(toolCalls.length, 1)
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { path: "a b.txt" })
})

test("base64 fences in the shapes models improvise are accepted", () => {
  const body = Buffer.from(JSON.stringify({ tool: "run_command", parameters: { command: "ls" } })).toString("base64")
  for (const tag of ["tool_call_base64", "tool_call base64", "tool_call:base64", "base64_tool_call", "tool_call"]) {
    const { toolCalls } = parseBase64ToolCalls("```" + tag + "\n" + body + "\n```")
    assert.equal(toolCalls.length, 1, `tag ${tag}`)
    assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { command: "ls" })
  }
})

test("url-safe base64 and a name line before the payload are handled", () => {
  const json = JSON.stringify({ name: "run_command", arguments: { command: "ls" } })
  const urlSafe = Buffer.from(json).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  assert.equal(parseBase64ToolCall(urlSafe)[0].name, "run_command")

  const inner = Buffer.from(json).toString("base64")
  const outer = Buffer.from("run_command\n" + inner).toString("base64")
  const calls = parseBase64ToolCall(outer)
  assert.equal(calls?.[0]?.name, "run_command")
})

test("a word, a TOML block or a non-JSON payload is not mistaken for a base64 call", () => {
  // a bare word passes the alphabet test but decodes to nothing usable
  assert.equal(looksBase64("tool_name"), false)
  assert.equal(parseBase64ToolCall("tool_name"), null)
  // a token that decodes to binary (an auth token, say) is not a call
  const token = "8XYjvWqHCTEzwIjRAN3kV1Fl673OdliyWs7LxsIrN+VMGTRXvn3ztkhsLqJ48MXr"
  assert.equal(looksBase64(token), true)
  assert.equal(parseBase64ToolCall(token), null)
  const { cleanText, toolCalls } = parseBase64ToolCalls("```tool_call_base64\n" + token + "\n```")
  assert.equal(toolCalls.length, 0)
  assert.match(cleanText, /tool_call_base64/, "an unparseable block is left as text, not dropped")
})

test("the configured format is parsed first and the other is the fallback", () => {
  const b64 = encodeToolCallBase64("run_command", { command: "ls" })
  assert.equal(parseToolCallsAnyFormat(b64, "base64").toolCalls[0].function.name, "run_command")
  assert.equal(parseToolCallsAnyFormat(b64, "base64").format, "base64")
  // asked for base64, model answered TOML: still a call
  const toml = '```tool_call\nname = "run_command"\n\n[parameters]\ncommand = "ls"\n```'
  const fell = parseToolCallsAnyFormat(toml, "base64")
  assert.equal(fell.toolCalls.length, 1)
  assert.equal(fell.format, "toml")
  // asked for TOML, model answered base64
  assert.equal(parseToolCallsAnyFormat(b64, "toml").toolCalls.length, 1)
  assert.equal(parseToolCallsAnyFormat("just prose", "toml").toolCalls.length, 0)
})

test("resolveToolFormat: option, then environment, then defaults to base64", () => {
  assert.equal(resolveToolFormat("base64"), "base64")
  assert.equal(resolveToolFormat("B64"), "base64")
  assert.equal(resolveToolFormat("encoded"), "base64")
  assert.equal(resolveToolFormat("toml"), "toml")
  assert.equal(resolveToolFormat(""), "base64")
  assert.equal(resolveToolFormat(undefined, {}), "base64")
  assert.equal(resolveToolFormat(undefined, { DEEPSEEK_WEB_TOOL_FORMAT: "toml" }), "toml")
  assert.equal(resolveToolFormat(undefined, { DEEPSEEK_WEB_TOOL_FORMAT: "base64" }), "base64")
  assert.equal(resolveToolFormat("toml", { DEEPSEEK_WEB_TOOL_FORMAT: "base64" }), "toml")
})

test("sanitizeArgumentValue and normalizeSingleToolCall clean hallucinated XML parameter tags and extra quotes", () => {
  const jsonWithTags = {
    name: "bash",
    parameters: {
      command: '"find src -type f | wc -l"</parameter>',
      timeout: 30,
    },
  }
  const calls = normalizeTomlToolCalls(jsonWithTags)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, "bash")
  assert.equal(calls[0].arguments.command, "find src -type f | wc -l")
  assert.equal(calls[0].arguments.timeout, 30)

  // base64 payload containing XML tags inside arguments
  const b64 = Buffer.from(JSON.stringify(jsonWithTags)).toString("base64")
  const parsed = parseBase64ToolCall(b64)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].arguments.command, "find src -type f | wc -l")
})

test("base64 payload accepts Codex and Claude Code standard call shapes", () => {
  // 1. Codex standard { name, arguments }
  const codexDoc = { name: "bash", arguments: { command: "git status" } }
  const codexB64 = Buffer.from(JSON.stringify(codexDoc)).toString("base64")
  const p1 = parseBase64ToolCall(codexB64)
  assert.equal(p1.length, 1)
  assert.equal(p1[0].name, "bash")
  assert.deepEqual(p1[0].arguments, { command: "git status" })

  // 2. OpenAI function wrapper { type: "function", function: { name, arguments } }
  const openAiDoc = {
    type: "function",
    id: "call_123",
    function: { name: "bash", arguments: JSON.stringify({ command: "git diff" }) },
  }
  const openAiB64 = Buffer.from(JSON.stringify(openAiDoc)).toString("base64")
  const p2 = parseBase64ToolCall(openAiB64)
  assert.equal(p2.length, 1)
  assert.equal(p2[0].name, "bash")
  assert.deepEqual(p2[0].arguments, { command: "git diff" })

  // 3. Claude Code standard { type: "tool_use", id, name, input }
  const claudeDoc = {
    type: "tool_use",
    id: "toolu_01AbCdEfGhIjKlMnOpQrSt",
    name: "bash",
    input: { command: "npm test" },
  }
  const claudeB64 = Buffer.from(JSON.stringify(claudeDoc)).toString("base64")
  const p3 = parseBase64ToolCall(claudeB64)
  assert.equal(p3.length, 1)
  assert.equal(p3[0].name, "bash")
  assert.deepEqual(p3[0].arguments, { command: "npm test" })

  // 4. Claude XML inside base64: <tool_use><name>...</name><input>...</input></tool_use>
  const claudeXml = "<tool_use>\n<name>read_file</name>\n<input>{\"path\": \"src/app.ts\"}</input>\n</tool_use>"
  const xmlB64 = Buffer.from(claudeXml).toString("base64")
  const p4 = parseBase64ToolCall(xmlB64)
  assert.equal(p4.length, 1)
  assert.equal(p4[0].name, "read_file")
  assert.deepEqual(p4[0].arguments, { path: "src/app.ts" })

  // 5. Claude Invoke XML inside base64: <invoke name="..."><parameter name="...">...</parameter></invoke>
  const invokeXml = '<invoke name="bash"><parameter name="command">ls -lh</parameter></invoke>'
  const invokeB64 = Buffer.from(invokeXml).toString("base64")
  const p5 = parseBase64ToolCall(invokeB64)
  assert.equal(p5.length, 1)
  assert.equal(p5[0].name, "bash")
  assert.deepEqual(p5[0].arguments, { command: "ls -lh" })
})

test("the base64 prompts show a real encoded example and forbid JSON in the reply", () => {
  const prompt = buildBase64ToolsPrompt(b64Tools, "auto")
  assert.match(prompt, /Encode that exact JSON text as base64/)
  assert.match(prompt, /```tool_call_base64/)
  assert.match(prompt, /the block holds base64 only/)
  // the example decodes back to the documented document
  const example = prompt.match(/```tool_call_base64\n([A-Za-z0-9+/=]+)\n```/)[1]
  assert.deepEqual(JSON.parse(Buffer.from(example, "base64").toString("utf8")), {
    name: "run_command",
    arguments: { command: "npm test" },
  })

  const anchor = buildBase64AnchorPrompt(b64Tools, "auto")
  assert.match(anchor, /highest priority/)
  assert.match(anchor, /Available tools: run_command\./)
  assert.match(anchor, /base64 ONLY/)
})

test("history tool calls are re-encoded in the base64 format", () => {
  const blocks = formatToolCallsToBase64([
    { id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"ls -la"}' } },
  ])
  assert.match(blocks, /^```tool_call_base64\n/)
  assert.deepEqual(parseBase64ToolCall(blocks.split("\n")[1])[0].arguments, { command: "ls -la" })
})

test("toolPromptsFor picks the pair for the format", () => {
  assert.equal(toolPromptsFor("base64", b64Tools, "auto").build, buildBase64ToolsPrompt)
  assert.equal(toolPromptsFor("toml", b64Tools, "auto").build, buildToolsPrompt)
})
