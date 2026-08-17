"use strict";
/** Loop scrubbing through the full path, including the frequency penalty. */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const { Harness, JSON_HEADERS } = require("./helpers");

const h = new Harness();
before(() => h.startUpstream());
after(() => h.stop());
beforeEach(() => h.stopProxy());

const ENV = { SCRUB_ASSISTANT_LOOPS: "1", DEFAULT_REASONING_EFFORT: "off" };
const LOOPY = "Let me run that command again.\n".repeat(40) + "Here is the actual answer.\n";

test("repeated assistant lines are collapsed", async () => {
  await h.startProxy(ENV);
  const seen = h.recordUpstream();
  await h.request({
    body: JSON.stringify({ model: "m", messages: [
      { role: "user", content: "go" }, { role: "assistant", content: LOOPY }] }),
    headers: JSON_HEADERS,
  });
  const a = seen.body.messages[1].content;
  assert.strictEqual((a.match(/Let me run that command again\./g) || []).length, 1);
  assert.match(a, /Here is the actual answer\./);
  assert.match(h.stdout, /scrubbed=/);
});

test("frequency penalty is added only when something was removed", async () => {
  await h.startProxy(ENV);
  const looped = h.recordUpstream();
  await h.request({
    body: JSON.stringify({ model: "m", messages: [
      { role: "user", content: "go" }, { role: "assistant", content: LOOPY }] }),
    headers: JSON_HEADERS,
  });
  assert.strictEqual(looped.body.frequency_penalty, 0.1);

  const clean = h.recordUpstream();
  await h.request({
    body: JSON.stringify({ model: "m", messages: [
      { role: "user", content: "go" },
      { role: "assistant", content:
        "I inspected the cache module and traced the lock usage.\n" +
        "The membership check happens outside the critical section.\n" +
        "That allows two callers to compute the same value twice.\n" +
        "Wrapping the read-modify-write in the lock fixes it.\n" },
    ]}),
    headers: JSON_HEADERS,
  });
  assert.ok(!("frequency_penalty" in clean.body), "clean requests are not penalised");
});

test("user and tool messages are never scrubbed", async () => {
  await h.startProxy(ENV);
  const seen = h.recordUpstream();
  await h.request({
    body: JSON.stringify({ model: "m", messages: [
      { role: "user", content: LOOPY },
      { role: "tool", tool_call_id: "t", content: LOOPY }] }),
    headers: JSON_HEADERS,
  });
  assert.strictEqual(seen.body.messages[0].content, LOOPY);
  assert.strictEqual(seen.body.messages[1].content, LOOPY);
});

test("markdown code fences survive", async () => {
  // Stripping these breaks every code block pairing in the replayed history.
  await h.startProxy(ENV);
  const doc = Array.from({ length: 12 }, (_, i) =>
    "```python\nprint(" + i + ")\n```\nSome prose to pad the document out.").join("\n");
  const seen = h.recordUpstream();
  await h.request({
    body: JSON.stringify({ model: "m", messages: [
      { role: "user", content: "go" }, { role: "assistant", content: doc }] }),
    headers: JSON_HEADERS,
  });
  assert.strictEqual((seen.body.messages[1].content.match(/```/g) || []).length, 24);
});

test("reasoning_content is scrubbed too", async () => {
  await h.startProxy(ENV);
  const seen = h.recordUpstream();
  await h.request({
    body: JSON.stringify({ model: "m", messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "fine", reasoning_content: LOOPY }] }),
    headers: JSON_HEADERS,
  });
  assert.strictEqual(
    (seen.body.messages[1].reasoning_content.match(/Let me run that command again\./g) || []).length, 1);
});

test("SCRUB_ASSISTANT_LOOPS unset leaves everything alone", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "off" });
  const seen = h.recordUpstream();
  await h.request({
    body: JSON.stringify({ model: "m", messages: [
      { role: "user", content: "go" }, { role: "assistant", content: LOOPY }] }),
    headers: JSON_HEADERS,
  });
  assert.strictEqual(seen.body.messages[1].content, LOOPY);
});
