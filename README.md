# magpie-deepseek-web

DeepSeek 网页版（`chat.deepseek.com`）的 magpie / OpenCode provider 插件，
用浏览器自己的 `userToken` 登录。是 [deepseek2api](https://github.com/0xgetz/deepseek2api)
的移植：不需要代理进程，不需要 Docker，没有第三方依赖。

> **说明**：上游社区包还在 PR 审核中
> （[magpie-community/plugins#247](https://github.com/magpie-community/plugins/pull/247)）。
> 合并后请改用 `@magpie-community/opencode-deepseek-web-auth`，这个仓库就可以不要了。
> 跟踪 issue：[Euraxluo/plugins#2](https://github.com/Euraxluo/plugins/issues/2)

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

## 限制

- 网页端只回文本，**不支持工具调用**。
- 每轮只发最后一条 user 消息，更早的上下文留在上游会话里。

## 测试

```sh
bun test
```
