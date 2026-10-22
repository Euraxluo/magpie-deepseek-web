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

test("an unclosed tool-call fence is suppressed rather than leaked", () => {
  const emitted = []
  const gate = new ToolFenceGate((c) => emitted.push(c))
  gate.push("All done. ")
  gate.push("```tool_call\nname = \"half")
  gate.flush()
  assert.equal(emitted.join(""), "All done. ")
})

test("invalid and unclosed legacy tool-call blocks are never leaked in streaming", () => {
  for (const block of [
    `\`\`\`tool_call\nnot a call\n\`\`\``,
    `\`\`\`tool_call\n{"name":"run_command","arguments":{"command":"ls"}}`,
    "<tool_call><name>bash</name><input>{}</input>",
  ]) {
    const emitted = []
    const gate = new ToolFenceGate((c) => emitted.push(c))
    gate.push(`before ${block}`)
    gate.flush()
    assert.equal(emitted.join(""), "before ")
  }
})

test("plaintext XML tool-call blocks are suppressed in streaming", () => {
  const emitted = []
  const gate = new ToolFenceGate((c) => emitted.push(c))
  gate.push("before <tool_")
  gate.push("call>name = \\\"bash\\\"</tool_call> after")
  gate.flush()
  assert.equal(emitted.join(""), "before  after")
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

// --- plaintext JSON tool calls ---------------------------------------------

import {
  formatToolCallJson,
  formatToolCallsToJson,
  parseJsonToolCalls,
  parseToolCallBlock,
  parseToolCallsAnyFormat,
  buildJsonToolsPrompt,
  buildJsonAnchorPrompt,
  resolveToolFormat,
  toolPromptsFor,
} from "./toml.mjs"

const jsonTools = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  },
]

test("a JSON tool call round-trips with awkward arguments intact", () => {
  const args = { command: 'echo "$HOME"\nawk \'{print $1}\' file.txt' }
  const block = formatToolCallJson("run_command", args)
  assert.match(block, /^```tool_call\n\{/)
  assert.equal(block.split("\n")[1], JSON.stringify({ name: "run_command", arguments: args }))

  const { cleanText, toolCalls } = parseJsonToolCalls(`On it.\n\n${block}\n\nDone.`)
  assert.equal(cleanText, "On it.\n\nDone.")
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].type, "function")
  assert.equal(toolCalls[0].function.name, "run_command")
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), args)
  assert.match(toolCalls[0].id, /^call_[0-9a-f]{16}$/)
})

test("multiple JSON fences and a tool_calls array return every call", () => {
  const first = formatToolCallJson("run_command", { command: "pwd" })
  const second = formatToolCallJson("read_file", { path: "a.txt" })
  const fenced = parseJsonToolCalls(`${first}\n\n${second}`)
  assert.deepEqual(fenced.toolCalls.map((call) => call.function.name), ["run_command", "read_file"])
  assert.deepEqual(fenced.toolCalls.map((call) => JSON.parse(call.function.arguments)), [
    { command: "pwd" },
    { path: "a.txt" },
  ])

  const document = JSON.stringify({
    tool_calls: [
      { id: "call_0", type: "function", function: { name: "run_command", arguments: { command: "pwd" } } },
      { id: "call_1", type: "function", function: { name: "read_file", arguments: { path: "a.txt" } } },
    ],
  })
  const arrayResult = parseJsonToolCalls("```tool_call\n" + document + "\n```")
  assert.deepEqual(arrayResult.toolCalls.map((call) => call.function.name), ["run_command", "read_file"])
  assert.deepEqual(arrayResult.toolCalls.map((call) => call.id), ["call_0", "call_1"])
})

test("JSON fences in the shapes models improvise are accepted", () => {
  const doc = JSON.stringify({ tool: "run_command", parameters: { command: "ls" } })
  for (const tag of ["tool_call", "tool-call", "tool_calls", "json_tool_call"]) {
    const { toolCalls } = parseJsonToolCalls("```" + tag + "\n" + doc + "\n```")
    assert.equal(toolCalls.length, 1, `tag ${tag}`)
    assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { command: "ls" })
  }
  // a <tool_call> wrapper is the same call in another spelling
  const xml = `<tool_call>\n${JSON.stringify({ name: "run_command", arguments: { command: "ls" } })}\n</tool_call>`
  assert.deepEqual(JSON.parse(parseJsonToolCalls(xml).toolCalls[0].function.arguments), { command: "ls" })
})

test("JSON accepts Codex and Claude Code standard call shapes", () => {
  const codex = parseToolCallBlock(JSON.stringify({ name: "bash", arguments: { command: "git status" } }))
  assert.deepEqual(codex.map((c) => [c.name, c.arguments]), [["bash", { command: "git status" }]])

  const openAi = parseToolCallBlock(
    JSON.stringify({ type: "function", id: "call_123", function: { name: "bash", arguments: JSON.stringify({ command: "git diff" }) } })
  )
  assert.deepEqual(openAi.map((c) => [c.name, c.arguments]), [["bash", { command: "git diff" }]])

  const claude = parseToolCallBlock(
    JSON.stringify({ type: "tool_use", id: "toolu_01AbCdEfGhIjKlMnOpQrSt", name: "bash", input: { command: "npm test" } })
  )
  assert.deepEqual(claude.map((c) => [c.name, c.arguments]), [["bash", { command: "npm test" }]])

  const xml = parseToolCallBlock('<tool_use>\n<name>read_file</name>\n<input>{"path": "src/app.ts"}</input>\n</tool_use>')
  assert.deepEqual(xml.map((c) => [c.name, c.arguments]), [["read_file", { path: "src/app.ts" }]])

  const invoke = parseToolCallBlock('<invoke name="bash"><parameter name="command">ls -lh</parameter></invoke>')
  assert.deepEqual(invoke.map((c) => [c.name, c.arguments]), [["bash", { command: "ls -lh" }]])
})

test("a JSON document wrapped in prose is still read", () => {
  const calls = parseToolCallBlock('Sure, here it is: {"name": "run_command", "arguments": {"command": "ls"}} Thanks')
  assert.deepEqual(calls.map((c) => [c.name, c.arguments]), [["run_command", { command: "ls" }]])
})

test("a fence with no call in it is left as text", () => {
  const { cleanText, toolCalls } = parseJsonToolCalls("```tool_call\nnot a call at all\n```")
  assert.equal(toolCalls.length, 0)
  assert.match(cleanText, /tool_call/, "an unparseable block is left as text, not dropped")
})

test("only the execution fence runs: prose and other code blocks do not", () => {
  const call = formatToolCallJson("run_command", { command: "ls" })
  assert.equal(parseToolCallsAnyFormat(call, "json").toolCalls[0].function.name, "run_command")
  assert.equal(parseToolCallsAnyFormat(call, "json").format, "json")

  // A bash block is display only, however command-like it looks.
  const bash = "```bash\nls -la\n```"
  assert.deepEqual(parseToolCallsAnyFormat(bash).toolCalls, [])

  // A sentence describing an action is not a call.
  assert.deepEqual(parseToolCallsAnyFormat("I will now run `ls -la`.").toolCalls, [])

  // Legacy encoded blocks are never executable now, and are stripped.
  const encoded = "```tool_call_base64\n" + Buffer.from(JSON.stringify({ name: "run_command", arguments: { command: "ls" } })).toString("base64") + "\n```"
  const legacy = parseToolCallsAnyFormat("before " + encoded + " after")
  assert.deepEqual(legacy.toolCalls, [])
  assert.equal(legacy.cleanText, "before  after")
})

test("tool-call format is always JSON", () => {
  assert.equal(resolveToolFormat("json"), "json")
  assert.equal(resolveToolFormat("base64"), "json")
  assert.equal(resolveToolFormat("toml"), "json")
  assert.equal(resolveToolFormat(""), "json")
  assert.equal(resolveToolFormat(undefined, {}), "json")
  assert.equal(resolveToolFormat(undefined, { DEEPSEEK_WEB_TOOL_FORMAT: "base64" }), "json")
  assert.equal(resolveToolFormat("base64", { DEEPSEEK_WEB_TOOL_FORMAT: "toml" }), "json")
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

  // the same document arriving through the fence
  const parsed = parseToolCallBlock(JSON.stringify(jsonWithTags))
  assert.equal(parsed[0].arguments.command, "find src -type f | wc -l")
})

test("the JSON prompts show a real example and ask for JSON only", () => {
  const prompt = buildJsonToolsPrompt(jsonTools, "auto")
  assert.match(prompt, /```tool_call\n/)
  assert.match(prompt, /"arguments"/)
  assert.match(prompt, /The block holds JSON only/)

  const sampleJson = prompt.match(/```tool_call\n(.+)\n```/)[1]
  assert.deepEqual(JSON.parse(sampleJson), { name: "run_command", arguments: { command: "npm test" } })

  const anchor = buildJsonAnchorPrompt(jsonTools, "auto")
  assert.match(anchor, /highest priority/)
  assert.match(anchor, /Available tools and current argument schemas:/)
  assert.match(anchor, /\"properties\":\{\"command\":\{\"type\":\"string\"\}\}/)
  assert.match(anchor, /Emit independent tool calls as separate blocks in the same response/)
  assert.doesNotMatch(anchor, /ONE .*block|FIRST one now/)

  const serial = buildJsonAnchorPrompt(jsonTools, "auto", false)
  assert.match(serial, /Emit exactly one tool call in this response; parallel calls are disabled/)
  assert.doesNotMatch(serial, /Emit independent tool calls as separate blocks/)
})

test("history tool calls are rebuilt as JSON blocks", () => {
  const blocks = formatToolCallsToJson([
    { id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"ls -la"}' } },
  ])
  assert.match(blocks, /^```tool_call\n\{/)
  assert.deepEqual(JSON.parse(blocks.split("\n")[1]), { name: "run_command", arguments: { command: "ls -la" } })
})

test("toolPromptsFor always selects the JSON format", () => {
  assert.equal(toolPromptsFor("json", jsonTools, "auto").build, buildJsonToolsPrompt)
  assert.equal(toolPromptsFor("base64", jsonTools, "auto").build, buildJsonToolsPrompt)
  assert.equal(toolPromptsFor("toml", jsonTools, "auto").build, buildJsonToolsPrompt)
})
