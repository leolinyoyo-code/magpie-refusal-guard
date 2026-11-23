# magpie-refusal-guard

magpie 网关中间件：**注入工程模式系统提示词** + **拦截拒答形态的回复**。

不做代理、不碰账号，只在请求送到上游之前和回复返回客户端的路上各做一件事：

1. **注入（inject）** —— 给请求加一段可配置的系统提示词（默认是一段「工程执行模式」），让模型少说教、直接交付。默认追加到已有 system 后面，不覆盖你自己写的规则；四种 API 协议各自放在正确的位置。
2. **拦截（guard）** —— 看可见回复的开头，命中拒答形态（`抱歉`、`我无法`、`I can't`、`对不起`…）就替换或丢弃。流式（`onEvent`）和非流式（`onResponse`）都覆盖。

## 安装

```bash
# 直接从 GitHub 安装
magpie plugin add github:codeyoyo/magpie-refusal-guard

# 或单文件安装（本仓库的中间件文件）
magpie plugin add ./refusal-guard.middleware.js

# 或从一个目录 / npm 包安装
magpie plugin add ./magpie-refusal-guard
magpie plugin add magpie-refusal-guard
```

装完后按需设置选项（不设置也能跑，默认全开）：

```bash
magpie plugin options refusal-guard '{"inject": true, "guard": true, "action": "replace"}'
```

插件名是文件去掉 `.middleware.js` 的部分（`refusal-guard`），在 `插件 → 已安装` 里也能改选项。改动从下一个请求起生效。

## 选项

| 键 | 默认 | 说明 |
|---|---|---|
| `inject` | `true` | 是否注入系统提示词 |
| `prompt` | `""` | 自定义注入内容；空表示用内置的工程模式提示词 |
| `override` | `true` | 请求已有 system 时是否仍然注入 |
| `position` | `"append"` | `append` 追加在已有 system 后，`prepend` 放前面 |
| `agents` | `[]` | 只对这些 agent（`ctx.agent`）生效；空表示全部 |
| `models` | `[]` | 只对这些模型生效；是模型 id 的**前缀**，可匹配任意 `/` 之后的段 |
| `guard` | `true` | 是否拦截拒答形态的回复 |
| `action` | `"replace"` | `replace` 换成 `fallback` 文案；`drop` 直接丢弃 |
| `fallback` | 内置文案 | 替换时显示的文本 |
| `aggressive` | `false` | 是否把「能，但…」「首先需要说明」这类软拒答也判为拒答 |
| `holdChars` | `12` | 流式缓冲上限（字符）；正常情况下会更早放行 |
| `patterns` | `[]` | 额外的正则（字符串），命中回复开头即判为拒答 |

示例：

```bash
# 只对 Claude Code 生效，保留它自己的系统提示词前缀
magpie plugin options refusal-guard '{"agents":["claude"],"position":"prepend"}'

# 只在 workbuddy 的模型上拦软拒答，命中后回一句自定义文案
magpie plugin options refusal-guard '{"models":["workbuddy"],"aggressive":true,"fallback":"[blocked]"}'

# 只注入，不拦回复
magpie plugin options refusal-guard '{"inject":true,"guard":false}'
```

## 支持的协议

magpie 会把同一个请求转成上游使用的任意协议，中间件看到的是 **agent 自己的 API 格式**（`ctx.protocol`）：

| 协议 | 注入位置 | 流式文本位置 |
|---|---|---|
| `chat`（Chat Completions） | 第一条 `system` / `developer` 消息 | `choices[].delta.content` |
| `anthropic`（Messages） | `system`（字符串或 text block 数组） | `content_block_delta.delta.text` |
| `responses` | `instructions` | `response.output_text.delta.delta` |
| `gemini` | `systemInstruction.parts` | `candidates[].content.parts[].text` |

## 工作方式

注入和拦截是两条独立的路径，可以分开开关。

**注入**用 `onRequest`，路由组请求（`group/...`）在 `onProvider` 里再判断一次成员模型。注入内容开头带 `[refusal-guard]` 标记，重复调用不会叠加。

**流式拦截**的关键是不要吞掉正常回复：

- 回复开头如果**已经能排除**拒答（例如以「好」「这」「我」之后接非拒答词开头），立刻放行，不缓冲；
- 只有在开头**仍然可能是拒答**（例如「抱」「我无」「I ca」）时才扣住，等下一个事件；
- 一旦命中形态，当前事件替换成 `fallback`，后续文本事件丢弃，结构事件（`finish_reason`、`message_stop` 等）照常透传；
- 缓冲上限 `holdChars` 兜底，防止异常情况把流卡住。

**非流式**在 `onResponse` 里检查整段可见文本，命中就替换或清空。

## 限制（重要）

- **不重试、不换模型。** magpie 的中间件跑在 Go 的 moejs 引擎里，没有 `fetch`、没有定时器，钩子只有 250ms（事件 50ms）。「命中拒答后换一个上游再问一次」属于 provider 插件或 magpie 路由组的职责（上游返回 `content_filter` 时 magpie 自己会向同组下一成员重试），本插件不碰。
- **只拦开头形态。** 回复中途才出现「抱歉，我无法…」不会被拦，因为流式内容已经发出去了。
- **流式多 choice 只处理第一个有文本的 choice。**
- **可能误伤。** 「抱歉这个词的用法是…」这类正常回答也会被判为拒答。默认只匹配强拒答开场，误伤面很小；`aggressive` 打开后误伤面明显变大，按需使用。
- **短回复边界**：如果一条正常回复恰好停在「我很」这种拒答前缀上就结束，会被扣住。实际流式回复极少有这种情况。
- 上游的**服务端内容审核**改不了；本插件只影响「模型看到什么」和「客户端看到什么」。

## 安全与合规

这个插件改的是发给模型的提示词和返回给客户端的文本。用它绕过服务的条款、风控或内容审核，后果由使用者承担（账号封禁是最常见的一种）。只在你自己的环境、自己的账号上使用。

## 测试

```bash
node --test test/*.test.mjs
```

35 个用例，覆盖四协议注入、幂等、过滤、流式逐字/跨事件拒答、软拒答开关、误伤场景、非流式替换。

MIT License.
