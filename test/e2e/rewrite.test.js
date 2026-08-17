"use strict";
/** Request-body rewriting: effort injection, and the safety rails around it. */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const { Harness, JSON_HEADERS, chatBody } = require("./helpers");

const h = new Harness();
before(() => h.startUpstream());
after(() => h.stop());
beforeEach(() => h.stopProxy());

test("injects reasoning_effort when the client sent none", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max" });
  const seen = h.recordUpstream();
  const r = await h.request({ body: chatBody({ max_tokens: 2048 }), headers: JSON_HEADERS });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(seen.body.reasoning_effort, "max");
  assert.strictEqual(seen.body.messages[0].content, "hi", "messages untouched");
  assert.strictEqual(
    seen.headers["content-length"], String(Buffer.byteLength(seen.raw)),
    "content-length rewritten to match");
});

test("client-supplied effort wins by default", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max" });
  const seen = h.recordUpstream();
  await h.request({ body: chatBody({ reasoning_effort: "low" }), headers: JSON_HEADERS });
  assert.strictEqual(seen.body.reasoning_effort, "low");
});

test("override replaces the client's value", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max", REASONING_EFFORT_OVERRIDE: "1" });
  const seen = h.recordUpstream();
  await h.request({ body: chatBody({ reasoning_effort: "low" }), headers: JSON_HEADERS });
  assert.strictEqual(seen.body.reasoning_effort, "max");
});

test("chunked request bodies are normalised to a fixed length", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max" });
  const seen = h.recordUpstream();
  await h.request({ body: chatBody(), headers: JSON_HEADERS, chunked: true });
  assert.strictEqual(seen.body.reasoning_effort, "max");
  assert.strictEqual(seen.headers["content-length"], String(Buffer.byteLength(seen.raw)));
  assert.ok(!seen.headers["transfer-encoding"], "transfer-encoding dropped after rewrite");
});

test("non-JSON content types are forwarded byte for byte", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max" });
  const seen = h.recordUpstream();
  const body = chatBody();
  await h.request({ body, headers: { "content-type": "text/plain" } });
  assert.strictEqual(seen.raw, body);
});

test("other paths are never rewritten", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max" });
  const seen = h.recordUpstream();
  const body = chatBody();
  await h.request({ path: "/v1/completions", body, headers: JSON_HEADERS });
  assert.strictEqual(seen.raw, body);
});

test("malformed JSON is forwarded unmodified, not rejected", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max" });
  const seen = h.recordUpstream();
  const body = "{not json";
  const r = await h.request({ body, headers: JSON_HEADERS });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(seen.raw, body);
});

test("query strings still match the injectable path", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max" });
  const seen = h.recordUpstream();
  await h.request({ path: "/v1/chat/completions?foo=1", body: chatBody(), headers: JSON_HEADERS });
  assert.strictEqual(seen.body.reasoning_effort, "max");
});

test("oversized bodies stream through without rewriting", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "max", MAX_REWRITE_BODY_BYTES: "512" });
  const seen = h.recordUpstream();
  const body = chatBody({ pad: "x".repeat(2000) });
  await h.request({ body, headers: JSON_HEADERS });
  assert.strictEqual(seen.raw, body);
});

test("effort=off disables injection entirely", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "off" });
  const seen = h.recordUpstream();
  const body = chatBody();
  await h.request({ body, headers: JSON_HEADERS });
  assert.strictEqual(seen.raw, body);
});

test("an invalid effort value disables injection instead of crashing", async () => {
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "bogus" });
  const seen = h.recordUpstream();
  const body = chatBody();
  await h.request({ body, headers: JSON_HEADERS });
  assert.strictEqual(seen.raw, body);
  assert.match(h.stdout, /invalid DEFAULT_REASONING_EFFORT/);
});
