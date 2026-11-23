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
