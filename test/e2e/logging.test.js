"use strict";
/** The [effort] lines must be useful for debugging and must never leak content. */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const { Harness, JSON_HEADERS, chatBody } = require("./helpers");

const h = new Harness();
before(() => h.startUpstream());
after(() => h.stop());
beforeEach(() => h.stopProxy());

const SECRET_PROMPT = "SECRET-USER-PROMPT";
const SECRET_THINKING = "SECRET-REASONING-TEXT";
const SECRET_ANSWER = "SECRET-ANSWER-TEXT";

test("request line reports parameters, not content", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max" });
  h.recordUpstream();
  await h.request({
    body: JSON.stringify({ model: "deepseek-v4-flash-0731", max_tokens: 2048,
      messages: [{ role: "user", content: SECRET_PROMPT }] }),
    headers: JSON_HEADERS,
  });
  await h.waitForLog("req model=deepseek-v4-flash-0731");
  assert.match(h.stdout, /effort_client=unset/);
  assert.match(h.stdout, /effort_sent=max/);
  assert.match(h.stdout, /injected=yes/);
  assert.match(h.stdout, /max_tokens=2048/);
  assert.match(h.stdout, /messages=1/);
  assert.ok(!h.stdout.includes(SECRET_PROMPT), "prompt must not leak");
});

test("response line reports counters, not content", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max" });
  h.recordUpstream({
    id: "x",
    choices: [{ index: 0, finish_reason: "stop",
      message: { role: "assistant", content: SECRET_ANSWER, reasoning_content: SECRET_THINKING } }],
    usage: { prompt_tokens: 131, completion_tokens: 35405, reasoning_tokens: 35166 },
  });
  const r = await h.request({ body: chatBody(), headers: JSON_HEADERS });
  assert.match(r.body, new RegExp(SECRET_ANSWER), "client still gets the real body");
  await h.waitForLog("res status=200");
  assert.match(h.stdout, /prompt=131/);
  assert.match(h.stdout, /completion=35405/);
  assert.match(h.stdout, /reasoning=35166/);
  assert.match(h.stdout, /finish=stop/);
  assert.match(h.stdout, /thinking=yes/);
  assert.match(h.stdout, /content=yes/);
  assert.ok(!h.stdout.includes(SECRET_THINKING), "reasoning must not leak");
  assert.ok(!h.stdout.includes(SECRET_ANSWER), "answer must not leak");
});

test("streaming usage is picked up from the final chunk", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max" });
  h.upstreamHandler = (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"choices":[{"delta":{"reasoning_content":"${SECRET_THINKING}"}}]}\n\n`);
      res.write(`data: {"choices":[{"delta":{"content":"${SECRET_ANSWER}"},"finish_reason":"length"}]}\n\n`);
      res.write('data: {"choices":[],"usage":{"prompt_tokens":117,"completion_tokens":2000,"reasoning_tokens":2000}}\n\n');
      res.end("data: [DONE]\n\n");
    });
  };
  await h.request({ body: chatBody({ stream: true }), headers: JSON_HEADERS });
  await h.waitForLog("res status=200");
  assert.match(h.stdout, /reasoning=2000/);
  assert.match(h.stdout, /finish=length/);
  assert.ok(!h.stdout.includes(SECRET_THINKING));
});

test("a max_tokens truncation is visible in the log", async () => {
  // finish=length with content=no is the signature of thinking cut short.
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max" });
  h.recordUpstream({
    id: "x",
    choices: [{ index: 0, finish_reason: "length",
      message: { role: "assistant", content: "", reasoning_content: "..." } }],
    usage: { prompt_tokens: 117, completion_tokens: 2000, reasoning_tokens: 2000 },
  });
  await h.request({ body: chatBody(), headers: JSON_HEADERS });
  await h.waitForLog("res status=200");
  assert.match(h.stdout, /finish=length/);
  assert.match(h.stdout, /content=no/);
  assert.match(h.stdout, /thinking=yes/);
});

test("LOG_REASONING=0 silences the effort log", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max", LOG_REASONING: "0" });
  h.recordUpstream();
  await h.request({ body: chatBody(), headers: JSON_HEADERS });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!h.stdout.includes("[effort]"));
});

test("non-chat requests produce no effort log", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max" });
  h.recordUpstream();
  await h.request({ path: "/v1/models", method: "GET" });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!h.stdout.includes("[effort]"));
});

test("think-pattern dump shows which turns carry reasoning", async () => {
  await h.startProxy({ DUMP_REQUEST: "struct", DUMP_MIN_MESSAGES: "5", BACKFILL_REASONING: "0" });
  h.recordUpstream();
  const messages = [{ role: "user", content: "go" }];
  for (let i = 0; i < 6; i++) {
    const a = { role: "assistant", content: null,
      tool_calls: [{ id: `p${i}`, type: "function", function: { name: "f", arguments: "{}" } }] };
    if (i === 0 || i === 3) a.reasoning_content = "thought";
    messages.push(a, { role: "tool", tool_call_id: `p${i}`, content: "out" });
  }
  await h.request({ body: JSON.stringify({ model: "m", messages }), headers: JSON_HEADERS });
  await h.waitForLog("think-pattern");
  assert.match(h.stdout, /turns=6 filled=2 \(33%\)/);
  assert.match(h.stdout, /trailing_empty=2/);
  assert.match(h.stdout, /tail=#\.\.#\.\./);
});
