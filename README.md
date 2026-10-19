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

| 模型 | 深度思考 | 联网搜索 |
|---|---|---|
| `deepseek-web/deepseek-chat` | | |
| `deepseek-web/deepseek-reasoner` | ✓ | |
| `deepseek-web/deepseek-search` | | ✓ |
| `deepseek-web/deepseek-reasoner-search` | ✓ | ✓ |

## 工具调用（TOML）

网页端没有协议层的 function calling，只有文本。插件把工具定义写进系统提示，
让模型用 **TOML** 输出工具调用，再解析回标准 OpenAI `tool_calls`。

**参数一律用 TOML，不用 JSON**：

- 命令、文件内容、diff 这类多行参数放进 `'''…'''` 字面量多行字符串，原样传输。
  JSON 要把每个换行写成 `\n`、每个引号转义，长参数里模型经常写错，一个坏转义
  整次调用就丢了。
- 没有花括号/方括号配平问题，截断或字段顺序变化都还能解析。
- 同样的 schema 下 token 更少，围栏也更好读。

要求的格式：

````
```tool_call
name = "run_command"

[parameters]
command = '''
npm test
'''
timeout = 30
```
````

插件做的事：

- **首轮**：工具 schema 和格式说明写进 `[System]` 块；提示词末尾再加一条最高
  优先级的锚点。agent 的系统提示动辄几十 KB（Codex 约 40 KB），会把格式说明
  冲没，模型于是答「我没有工具」。
- **后续轮**：这一轮只发工具结果，末尾再补一次锚点；历史留在上游会话里。
- **流式**：`tool_call` 围栏内的内容先扣住，闭合后解析成 `tool_calls` 分片，
  `finish_reason: "tool_calls"`；围栏外的正文照常实时下发，围栏原文不会漏进
  `delta.content`。
- **非流式**：`message.tool_calls`，`content` 里去掉围栏，
  `finish_reason: "tool_calls"`。
- **下一轮**：把 assistant 的 `tool_calls` 和其后的 `tool` 消息折回成 TOML 块
  和一行干净的结果，模型看到的就是它被要求输出的格式。

`tool_choice` 按提示词能做的做：`none` 不注入工具，`required` 和指定函数会加
「必须调用，不要自己回答」，并裁掉其他工具。

## 限制

- 工具调用是提示词级的，不是协议。模型自己答得上来的问题可能仍会直接回答，
  `required` 也只能"要求"而不能真正强制。
- 每轮只发最后一条 assistant 之后的消息，更早的上下文留在上游会话里。
- 网页端对超长提示词是**从尾部静默截断**，所以每轮只发增量就是为了别撞这个墙。

## 测试

```sh
bun test
```
