# magpie-deepseek-web

DeepSeek 网页版（`chat.deepseek.com`）的 magpie / OpenCode provider 插件，
用浏览器自己的 `userToken` 登录。是 [deepseek2api](https://github.com/0xgetz/deepseek2api)
的移植：不需要代理进程，不需要 Docker，没有第三方依赖。

> **说明**：社区仓库没有接收这个包（PR
> [magpie-community/plugins#247](https://github.com/magpie-community/plugins/pull/247)
> 已关闭：一是网页端 PoW 反滥用设计上的顾虑，二是当时它不支持工具调用）。
> 这个仓库是自用版本，工具调用已经补上。DeepSeek 官方 API 有正规的、支持
> 工具调用的接入方式，长期使用请优先考虑它；用这个包等于用网页账号承担网页端
> 使用条款的风险。

## 安装

```sh
magpie plugin add github:Euraxluo/magpie-deepseek-web
magpie plugin login deepseek-web
```

## 登录

只需要网页版的 `userToken`：

1. 登录 <https://chat.deepseek.com>
2. F12 → Application → Local Storage → `https://chat.deepseek.com`
3. 复制 `userToken` 的值（`eyJ…` 原文、`Bearer …`、或 `{"value":"…"}` 都行）

## 模型

只提供单一模型 `deepseek-web/deepseek-web`。插件将 DeepSeek Web 的 `model_type` 固定为 `null`，由网页会话选择当前模型，不把 provider 模型名映射成网页端模型 ID。

## 工具调用（明文 JSON）

网页端没有协议层的 function calling，只有文本。插件把工具 schema 写入系统提示，
要求模型把每次调用写成 `tool_call` 围栏里的一个 JSON 文档：

````
```tool_call
{"name": "run_command", "arguments": {"command": "npm test"}}
```
````

`arguments` 直接是工具自己的参数对象，命令、文件内容和 diff 原样放在里面。
Codex 的 `{name, arguments}`、Claude Code 的 `{type:"tool_use", name, input}`
以及 `{tool_calls: [...]}` 数组都能识别；同一轮写多个围栏即为并行调用。
兼容上游偶发的 DSML（单/双竖线、全角/ASCII、带空格的 calls/tool_calls 标签）；
字符串参数保留原始空白、引号和换行，不做可能改变文件内容的清洗。Base64 调用不再执行。

有工具的响应会缓冲到本轮结束，再统一解析和校验整批调用。校验工具名称、参数对象、
必填字段、类型、schema 明确禁止的额外字段及 tool_choice/parallel_tool_calls。
通过后转换为标准 OpenAI `tool_calls`（并行调用按 `index: 0,1,…` 发出）。
无效、截断、未知工具的调用不会原样泄漏或以正常 stop 结束；任何工具执行前最多请求上游纠正一次，
再次失败则返回 `invalid_tool_call` 并回滚会话父节点，避免无限重试和部分批次被执行。
代价是工具回合的正文要等上游整轮结束才显示；推理内容仍按原有方式流式传输。

历史工具调用按 JSON 格式重建。明确的旧 TOML 围栏仍兼容；裸 JSON、普通 bash 代码块
以及描述性文字不会作为工具调用执行。

`tool_choice` 通过提示词处理：`none` 不注入工具，`required` 和指定函数会要求调用，并裁掉其他工具。
旧配置中的 `toolFormat` 和 `DEEPSEEK_WEB_TOOL_FORMAT` 不再切换协议，始终使用明文 JSON。

## 限制

- 上游工具调用依赖文本生成，不能承诺模型永远生成正确调用；`required` 未满足时会纠正一次，
  仍未满足则明确报错。参数校验覆盖常用结构约束，不等同于完整 JSON Schema 规范验证器。
- 每轮只发最后一条 assistant 之后的消息，更早的上下文留在上游会话里。
  这里算的是**最后一条有内容的 assistant**（有正文或有工具调用）：客户端重放空 stop 时会追加一条
  空 assistant，若以它为界，重试请求就只剩工具锚点、没有任务和工具结果，模型会从零重新开始。
- 上游这一轮没有正文也没有工具调用（只有推理，或空 stop），或续接本身失败时：先在同一个网页会话里从上一个节点重试一次；还不行就丢掉这个会话，在 DeepSeek 网页上新开一个 chat session，把当前请求的完整历史发过去，之后的轮次接着这个新会话，直到它再失败。登录失效、限流和客户端取消不会新开会话。为了在空 stop 到达客户端之前换会话，这一轮的推理和正文会等上游结束再一起发出。
- 网页端的“消息发送过于频繁”是流里的 `event: hint`（`finish_reason: rate_limit_reached`），HTTP 仍是 200 且没有正文。这种回合按 429 返回给客户端，不当作空回合重试：立刻重试只会把限流拖得更久。
- 网页端对超长提示词是**从尾部静默截断**，所以每轮只发增量就是为了别撞这个墙。换新会话那一次例外：完整历史要重发一遍，之后的轮次仍只发增量。

## 测试

```sh
bun test
```
