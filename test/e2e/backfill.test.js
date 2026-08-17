"use strict";
/**
 * The main workaround, exercised through the real request path: reasoning
 * captured from a response must reappear in the next request.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const { Harness, JSON_HEADERS, chatBody, TOOLS_PARAM } = require("./helpers");

const h = new Harness();
before(() => h.startUpstream());
after(() => h.stop());
beforeEach(() => h.stopProxy());

const ENV = { BACKFILL_REASONING: "1", DEFAULT_REASONING_EFFORT: "off" };

function replayBody(toolCallId, withReasoning) {
  const assistant = {
    role: "assistant", content: null,
    tool_calls: [{ id: toolCallId, type: "function",
      function: { name: "read_file", arguments: "{}" } }],
  };
  if (withReasoning) assistant.reasoning_content = "client kept its own";
  return JSON.stringify({
    model: "m", tools: TOOLS_PARAM,
    messages: [
      { role: "user", content: "go" },
      assistant,
      { role: "tool", tool_call_id: toolCallId, content: "file contents" },
    ],
  });
}

test("reasoning is captured and replayed onto the same turn", async () => {
  await h.startProxy(ENV);
  h.toolCallUpstream("I should read the cache module first.", "call_aaa");
  await h.request({ body: chatBody(), headers: JSON_HEADERS });
  await h.waitForLog("res status=200");

  const seen = h.recordUpstream();
  await h.request({ body: replayBody("call_aaa", false), headers: JSON_HEADERS });
  assert.strictEqual(seen.body.messages[1].reasoning_content,
    "I should read the cache module first.");
  assert.match(h.stdout, /backfilled=1/);
});

test("reasoning the client kept is never overwritten", async () => {
  await h.startProxy(ENV);
  h.toolCallUpstream("proxy cached version", "call_bbb");
  await h.request({ body: chatBody(), headers: JSON_HEADERS });
  await h.waitForLog("res status=200");

  const seen = h.recordUpstream();
  await h.request({ body: replayBody("call_bbb", true), headers: JSON_HEADERS });
  assert.strictEqual(seen.body.messages[1].reasoning_content, "client kept its own");
});

test("a cache miss leaves the request untouched", async () => {
  await h.startProxy(ENV);
  const seen = h.recordUpstream();
  await h.request({ body: replayBody("call_never_seen", false), headers: JSON_HEADERS });
  assert.ok(!("reasoning_content" in seen.body.messages[1]),
    "must not invent reasoning");
});

test("streamed reasoning deltas are joined before caching", async () => {
  await h.startProxy(ENV);
  h.upstreamHandler = (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"first part "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"reasoning_content":"second part"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_ccc",' +
        '"type":"function","function":{"name":"read_file","arguments":"{}"}}]},' +
        '"finish_reason":"tool_calls"}]}\n\n');
      res.end("data: [DONE]\n\n");
    });
  };
  await h.request({ body: chatBody({ stream: true }), headers: JSON_HEADERS });
  await h.waitForLog("res status=200");

  const seen = h.recordUpstream();
  await h.request({ body: replayBody("call_ccc", false), headers: JSON_HEADERS });
  assert.strictEqual(seen.body.messages[1].reasoning_content, "first part second part");
});

test("a turn that answered without calling a tool is also repaired", async () => {
  // Keyed by content hash, since there is no tool_call_id to use.
  await h.startProxy(ENV);
  const ANSWER = "The race is between the membership check and the store.";
  h.recordUpstream({
    id: "x",
    choices: [{ index: 0, finish_reason: "stop",
      message: { role: "assistant", content: ANSWER,
        reasoning_content: "traced both callers and the lock scope" } }],
    usage: { prompt_tokens: 5, completion_tokens: 9, reasoning_tokens: 40 },
  });
  await h.request({ body: chatBody(), headers: JSON_HEADERS });
  await h.waitForLog("res status=200");

  const seen = h.recordUpstream();
  await h.request({
    body: JSON.stringify({ model: "m", tools: TOOLS_PARAM, messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: ANSWER },
      { role: "user", content: "next" },
    ]}),
    headers: JSON_HEADERS,
  });
  assert.strictEqual(seen.body.messages[1].reasoning_content,
    "traced both callers and the lock scope");
});

test("without tools, turns before the last user are skipped", async () => {
  await h.startProxy(ENV);
  for (const id of ["old1", "new1"]) {
    h.toolCallUpstream(`thought ${id}`, id);
    await h.request({ body: chatBody(), headers: JSON_HEADERS });
    await h.waitForLog("res status=200");
  }
  const turn = (id) => ([
    { role: "assistant", content: null,
      tool_calls: [{ id, type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: id, content: "out" },
  ]);
  const seen = h.recordUpstream();
  await h.request({
    body: JSON.stringify({ model: "m", messages: [   // deliberately no tools
      { role: "user", content: "first" }, ...turn("old1"),
      { role: "user", content: "second" }, ...turn("new1"),
    ]}),
    headers: JSON_HEADERS,
  });
  const byId = (id) => seen.body.messages.find((m) => m.tool_calls && m.tool_calls[0].id === id);
  assert.ok(!("reasoning_content" in byId("old1")), "stripped by SGLang anyway");
  assert.strictEqual(byId("new1").reasoning_content, "thought new1");
});

test("BACKFILL_REASONING=0 makes it inert", async () => {
  await h.startProxy({ ...ENV, BACKFILL_REASONING: "0" });
  h.toolCallUpstream("should not be cached", "call_ddd");
  await h.request({ body: chatBody(), headers: JSON_HEADERS });
  await h.waitForLog("res status=200");

  const seen = h.recordUpstream();
  await h.request({ body: replayBody("call_ddd", false), headers: JSON_HEADERS });
  assert.ok(!("reasoning_content" in seen.body.messages[1]));
  assert.ok(!h.stdout.includes("backfilled="));
});
