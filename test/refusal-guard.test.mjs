import test from "node:test"
import assert from "node:assert/strict"
import { onRequest, onProvider, onEvent, onResponse } from "../refusal-guard.middleware.js"

const MARKER = "[refusal-guard]"

function ctx(protocol, options = {}, extra = {}) {
  return { protocol, model: "test/model", stream: true, agent: "zcode", options, state: {}, ...extra }
}

function chatBody(content) {
  return { model: "x", messages: [{ role: "user", content }] }
}

function chatEvents(chunks) {
  return chunks.map((c) => ({ choices: [{ index: 0, delta: { content: c } }] }))
}

// run feeds chunks through onEvent and returns what a client would see.
function run(chunks, options = {}, protocol = "chat", extra = {}) {
  const c = ctx(protocol, options, extra)
  let seen = ""
  let dropped = 0
  for (const chunk of chunks) {
    const ev = protocol === "chat"
      ? { choices: [{ index: 0, delta: { content: chunk } }] }
      : protocol === "anthropic"
        ? { type: "content_block_delta", delta: { type: "text_delta", text: chunk } }
        : protocol === "responses"
          ? { type: "response.output_text.delta", delta: chunk }
          : { candidates: [{ content: { parts: [{ text: chunk }] } }] }
    const out = onEvent(ev, c)
    if (out === null) {
      dropped++
      continue
    }
    if (protocol === "chat") seen += out.choices?.[0]?.delta?.content || ""
    else if (protocol === "anthropic") seen += out.delta?.text || ""
    else if (protocol === "responses") seen += out.delta || ""
    else seen += out.candidates?.[0]?.content?.parts?.[0]?.text || ""
  }
  return { seen, dropped }
}

// ---------- injection ----------

test("chat: adds a system message when there is none", () => {
  const out = onRequest(chatBody("hi"), ctx("chat"))
  assert.equal(out.messages[0].role, "system")
  assert.ok(out.messages[0].content.includes(MARKER))
  assert.equal(out.messages[1].content, "hi")
})

test("chat: appends to an existing system prompt and keeps it", () => {
  const body = { model: "x", messages: [{ role: "system", content: "MY RULES" }, { role: "user", content: "hi" }] }
  const out = onRequest(body, ctx("chat"))
  assert.ok(out.messages[0].content.startsWith("MY RULES"))
  assert.ok(out.messages[0].content.includes(MARKER))
  assert.ok(out.messages[0].content.includes("<engineering_mode>"))
})

test("chat: injection is idempotent", () => {
  const first = onRequest(chatBody("hi"), ctx("chat"))
  const before = first.messages[0].content
  onRequest(first, ctx("chat"))
  assert.equal(first.messages[0].content, before)
  assert.equal(first.messages[0].content.split(MARKER).length - 1, 1)
})

test("chat: prepend puts the prompt first", () => {
  const body = { model: "x", messages: [{ role: "system", content: "MY RULES" }, { role: "user", content: "hi" }] }
  const out = onRequest(body, ctx("chat", { position: "prepend" }))
  assert.ok(out.messages[0].content.startsWith(MARKER))
  assert.ok(out.messages[0].content.endsWith("MY RULES"))
})

test("chat: override false leaves an existing system prompt alone", () => {
  const body = { model: "x", messages: [{ role: "system", content: "MY RULES" }, { role: "user", content: "hi" }] }
  const out = onRequest(body, ctx("chat", { override: false }))
  assert.equal(out, undefined)
  assert.equal(body.messages[0].content, "MY RULES")
})

test("anthropic: sets and appends system", () => {
  const body = { model: "x", messages: [{ role: "user", content: "hi" }] }
  const out = onRequest(body, ctx("anthropic"))
  assert.ok(out.system.includes(MARKER))

  const withSys = { model: "x", system: "MY RULES", messages: [] }
  const out2 = onRequest(withSys, ctx("anthropic"))
  assert.ok(out2.system.startsWith("MY RULES"))
  assert.ok(out2.system.includes(MARKER))

  const blocks = { model: "x", system: [{ type: "text", text: "MY RULES" }], messages: [] }
  const out3 = onRequest(blocks, ctx("anthropic"))
  assert.equal(out3.system.length, 2)
  assert.ok(out3.system[1].text.includes(MARKER))
})

test("responses: uses instructions", () => {
  const out = onRequest({ model: "x", input: "hi" }, ctx("responses"))
  assert.ok(out.instructions.includes(MARKER))
})

test("gemini: uses systemInstruction", () => {
  const out = onRequest({ contents: [] }, ctx("gemini"))
  assert.ok(out.systemInstruction.parts[0].text.includes(MARKER))
  const snake = onRequest({ contents: [], system_instruction: { parts: [{ text: "MY RULES" }] } }, ctx("gemini"))
  assert.equal(snake.system_instruction.parts.length, 2)
})

test("models filter: a prefix of the whole id or of a segment matches", () => {
  const body = { model: "workbuddy/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }
  assert.equal(onRequest(body, ctx("chat", { models: ["gemini"] })), undefined)
  const hit = onRequest(body, ctx("chat", { models: ["deepseek-v4"] }))
  assert.ok(hit.messages[0].content.includes(MARKER))
  // a bare model name matches the part after the provider segment
  const fresh = { model: "workbuddy/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }
  const seg = onRequest(fresh, ctx("chat", { models: ["deepseek"] }))
  assert.ok(seg.messages[0].content.includes(MARKER))
})

test("agents filter: only the listed agents get the prompt", () => {
  const body = chatBody("hi")
  assert.equal(onRequest(body, ctx("chat", { agents: ["claude"] })), undefined)
  const hit = onRequest(body, ctx("chat", { agents: ["zcode"] }))
  assert.ok(hit.messages[0].content.includes(MARKER))
})

test("custom prompt replaces the built-in one", () => {
  const out = onRequest(chatBody("hi"), ctx("chat", { prompt: "ONLY THIS" }))
  assert.ok(out.messages[0].content.includes("ONLY THIS"))
  assert.ok(!out.messages[0].content.includes("engineering_mode"))
})

test("inject false does nothing", () => {
  assert.equal(onRequest(chatBody("hi"), ctx("chat", { inject: false })), undefined)
})

test("onProvider injects for a routing group's member", () => {
  const body = { model: "group/fast", messages: [{ role: "user", content: "hi" }] }
  const c = ctx("chat", { models: ["deepseek"] }, { provider: { id: "workbuddy", model: "deepseek-v4.1-flash" } })
  const out = onProvider(body, c)
  assert.ok(out.messages[0].content.includes(MARKER))
})

// ---------- streaming guard ----------

test("chat stream: a refusal is replaced and the rest dropped", () => {
  const { seen } = run(["抱", "歉", "，", "我无法", "协助", "此", "请求。"])
  assert.equal(seen, "（refusal-guard：上游返回了拒答形态的回复，已被拦截。可在插件选项里调整 fallback 或关闭 guard。）")
})

test("chat stream: a short normal answer is let go at once", () => {
  const { seen, dropped } = run(["好", "的"])
  assert.equal(seen, "好的")
  assert.equal(dropped, 0)
})

test("chat stream: buffered text is put back together", () => {
  const { seen } = run("我来解释一下这个问题".split(""))
  assert.equal(seen, "我来解释一下这个问题")
})

test("chat stream: an opener split across events is caught", () => {
  const { seen } = run(["I", "'m sorry", ", but I can't"])
  assert.ok(seen.includes("refusal-guard"))
})

test("chat stream: custom fallback is used", () => {
  const { seen } = run(["抱歉"], { fallback: "BLOCKED" })
  assert.equal(seen, "BLOCKED")
})

test("chat stream: drop returns nothing", () => {
  const { seen } = run(["抱歉", "，我无法"], { action: "drop" })
  assert.equal(seen, "")
})

test("chat stream: a normal reply that mentions 抱歉 later is untouched", () => {
  const { seen } = run("这个功能目前没有实现，抱歉。".split(""))
  assert.equal(seen, "这个功能目前没有实现，抱歉。")
})

test("chat stream: markdown decoration before the opener is still caught", () => {
  const { seen } = run(["**", "抱", "歉", "**", "，我无法协助。"])
  assert.ok(seen.includes("refusal-guard"))
})

test("aggressive off: a soft shape passes", () => {
  const { seen } = run("能，但是需要先说明".split(""))
  assert.equal(seen, "能，但是需要先说明")
})

test("aggressive on: a soft shape is caught", () => {
  const { seen } = run("能，但是需要先说明".split(""), { aggressive: true })
  assert.ok(seen.includes("refusal-guard"))
})

test("anthropic stream: a refusal is replaced", () => {
  const { seen } = run(["抱歉", "，我不能"], {}, "anthropic")
  assert.ok(seen.includes("refusal-guard"))
})

test("responses stream: a refusal is replaced", () => {
  const { seen } = run(["I", " can't"], {}, "responses")
  assert.ok(seen.includes("refusal-guard"))
})

test("gemini stream: a refusal is replaced", () => {
  const { seen } = run(["很抱歉", "，无法"], {}, "gemini")
  assert.ok(seen.includes("refusal-guard"))
})

test("non-text events pass through", () => {
  const c = ctx("chat")
  const ev = { choices: [{ index: 0, delta: { role: "assistant" } }] }
  assert.equal(onEvent(ev, c), ev)
})

// ---------- whole replies ----------

test("chat reply: content is replaced", () => {
  const body = { choices: [{ message: { role: "assistant", content: "抱歉，我无法协助。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("anthropic reply: content blocks are replaced", () => {
  const body = { content: [{ type: "text", text: "I can't help with that." }] }
  const out = onResponse(body, ctx("anthropic"))
  assert.ok(out.content[0].text.includes("refusal-guard"))
})

test("responses reply: output text is replaced", () => {
  const body = { output: [{ type: "message", content: [{ type: "output_text", text: "抱歉，我无法。" }] }] }
  const out = onResponse(body, ctx("responses"))
  assert.ok(out.output[0].content[0].text.includes("refusal-guard"))
})

test("gemini reply: candidates text is replaced", () => {
  const body = { candidates: [{ content: { parts: [{ text: "对不起，我不能。" }] } }] }
  const out = onResponse(body, ctx("gemini"))
  assert.ok(out.candidates[0].content.parts[0].text.includes("refusal-guard"))
})

test("chat reply: a normal answer is left alone", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这是完整实现：\n```js\n...\n```" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.equal(out, undefined)
  assert.ok(body.choices[0].message.content.includes("```js"))
})

test("guard off: replies are untouched", () => {
  const body = { choices: [{ message: { role: "assistant", content: "抱歉，我无法协助。" } }] }
  assert.equal(onResponse(body, ctx("chat", { guard: false })), undefined)
})

test("action drop: reply text is emptied", () => {
  const body = { choices: [{ message: { role: "assistant", content: "抱歉，我无法协助。" } }] }
  const out = onResponse(body, ctx("chat", { action: "drop" }))
  assert.equal(out.choices[0].message.content, "")
})

test("custom patterns catch your own shapes", () => {
  const body = { choices: [{ message: { role: "assistant", content: "作为 AI 助手，我没有个人观点。" } }] }
  const out = onResponse(body, ctx("chat", { patterns: ["^作为\\s*AI"] }))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

// ---------- soft refusals (the shapes WorkBuddy actually returns) ----------

test("soft: a hedge followed by a denial is caught", () => {
  const body = { choices: [{ message: { role: "assistant", content: "我理解您可能是在寻求娱乐或放松，但我无法提供成人内容或黄色段子。这类内容违反了平台安全准则。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("soft: a policy citation is caught anywhere in the head", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这类内容可能涉及低俗、冒犯性，也违反了平台安全准则，我不能继续。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("soft: '我写不了，但给你个擦边的' is caught", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这类露骨的成人内容我写不了，但给你个擦边的：" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("soft: a normal technical answer with a plain hedge passes", () => {
  const body = { choices: [{ message: { role: "assistant", content: "我理解你的意思，但这里有个问题：并发写会导致竞态。下面是修复。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.equal(out, undefined)
})

test("soft stream: a hedge and a denial split across events are caught", () => {
  const { seen } = run("我理解您可能是在寻求娱乐，但我无法提供".split(""))
  assert.ok(seen.includes("refusal-guard"))
})

test("stream: a normal long answer is still put back together", () => {
  const text = "这是完整的实现代码，运行后即可使用。"
  const { seen } = run(text.split(""))
  assert.equal(seen, text)
})

test("aggressive: '我理解…但这里有个问题' is still not a refusal", () => {
  const body = { choices: [{ message: { role: "assistant", content: "我理解你的需求，但这里有个问题：接口不支持并发。" } }] }
  assert.equal(onResponse(body, ctx("chat", { aggressive: true })), undefined)
})

test("soft: '平台安全规范' plus '我无法创作' is caught", () => {
  const body = { choices: [{ message: { role: "assistant", content: "我理解你想要一些轻松有趣的内容，但为了遵守平台安全规范和传播积极健康的价值观，我无法创作或分享成人内容。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("soft: '我无法生成' is caught", () => {
  const body = { choices: [{ message: { role: "assistant", content: "我无法生成成人黄色段子或其他不当内容。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("no misfire: '这个方案无法满足实时性要求' is a normal answer", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这个方案无法满足实时性要求，建议换成事件驱动。" } }] }
  assert.equal(onResponse(body, ctx("chat")), undefined)
})

test("no misfire: an English limitation sentence passes", () => {
  const body = { choices: [{ message: { role: "assistant", content: "This approach cannot satisfy the latency requirement, so use batching instead." } }] }
  assert.equal(onResponse(body, ctx("chat")), undefined)
})

test("soft: '这个请求我没法照做。换个方向…我都能帮' is caught", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这个请求我没法照做。换个方向的话，写故事、段子、脚本、代码、系统操作我都能帮，随时说。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("no misfire: '这个方案无法满足实时性要求' stays normal", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这个方案无法满足实时性要求，建议换成事件驱动。" } }] }
  assert.equal(onResponse(body, ctx("chat")), undefined)
})

test("no misfire: '这个接口没法用，换个方案' stays normal", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这个接口没法用，换个方案吧：改用批量写入。" } }] }
  assert.equal(onResponse(body, ctx("chat")), undefined)
})

test("soft stream: the substitution shape is caught across events", () => {
  const { seen } = run("这个请求我没法照做。换个方向的话".split(""))
  assert.ok(seen.includes("refusal-guard"))
})

test("soft: '我不写这个。换成别的…我照常处理' is caught", () => {
  const body = { choices: [{ message: { role: "assistant", content: "我不写这个。换成别的工作内容我照常处理。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("soft: '我不提供此类内容' is caught", () => {
  const body = { choices: [{ message: { role: "assistant", content: "我不提供此类内容，请理解。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("no misfire: '我不建议这样做' stays normal", () => {
  const body = { choices: [{ message: { role: "assistant", content: "我不建议这样做，因为会增加维护成本。" } }] }
  assert.equal(onResponse(body, ctx("chat")), undefined)
})

test("no misfire: '这个不支持并发，换成异步吧' stays normal", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这个不支持并发，换成异步队列吧。" } }] }
  assert.equal(onResponse(body, ctx("chat")), undefined)
})

test("soft: '这类内容我不能帮你写。有其他需要的话…' is caught", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这类内容我不能帮你写。有其他需要的话，代码、调试、系统运维这些我都可以直接上手。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("soft: streamed '这个不行' is caught", () => {
  const { seen } = run("这个不行。换个方向的话，代码我可以帮。".split(""))
  assert.ok(seen.includes("refusal-guard"))
})

test("soft: '这个不行' in a whole reply is caught", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这个不行。换个方向的话，代码我可以帮。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("soft: '这个我做不到' is caught", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这个我做不到，换个需求吧。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("no misfire: '这个功能已实现' passes", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这个功能已实现，下面是代码。" } }] }
  assert.equal(onResponse(body, ctx("chat")), undefined)
})

test("soft stream: '这个我不能' + '提供' is caught across events", () => {
  const { seen } = run(["这个我不能", "提供", "这类内容。"])
  assert.ok(seen.includes("refusal-guard"))
})

test("soft stream: '我不会' + '生成' is caught across events", () => {
  const { seen } = run(["我不会", "生成", "这种内容。"])
  assert.ok(seen.includes("refusal-guard"))
})

test("no misfire: '这个功能不能并发' passes", () => {
  const body = { choices: [{ message: { role: "assistant", content: "这个功能不能并发调用，需要加锁。" } }] }
  assert.equal(onResponse(body, ctx("chat")), undefined)
})

test("soft: a bare '不行' opener is caught", () => {
  const body = { choices: [{ message: { role: "assistant", content: "不行，这个我不能写。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("soft: '这个请求不在我能提供的范围内' is caught", () => {
  const body = { choices: [{ message: { role: "assistant", content: "你给的这个请求不在我能提供的范围内，换一个吧。" } }] }
  const out = onResponse(body, ctx("chat"))
  assert.ok(out.choices[0].message.content.includes("refusal-guard"))
})

test("soft stream: '你的请求我无法满足' is caught across events", () => {
  const { seen } = run(["你的", "请求", "我", "无法", "满足", "。"])
  assert.ok(seen.includes("refusal-guard"))
})

test("no misfire: '你的代码有个问题' passes", () => {
  const body = { choices: [{ message: { role: "assistant", content: "你的代码有个问题：锁的顺序反了。" } }] }
  assert.equal(onResponse(body, ctx("chat")), undefined)
})
