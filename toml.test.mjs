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
