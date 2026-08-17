"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const {
  extractQueueFullFromObj,
  extractQueueFullMessage,
  buildRateLimitBody,
  rewriteSSELine,
  collectStats,
} = require("../../src/upstream");

test("detects both queue-full shapes", () => {
  const wrapped = { error: { object: "error", message: "The request queue is full.", code: 503 } };
  const topLevel = { object: "error", message: "The request queue is full.", code: 503 };
  assert.match(extractQueueFullFromObj(wrapped), /queue is full/);
  assert.match(extractQueueFullFromObj(topLevel), /queue is full/);
});

test("ignores other 503s and lookalike text", () => {
  assert.strictEqual(
    extractQueueFullFromObj({ error: { message: "Internal server error", code: 503 } }), null);
  assert.strictEqual(
    extractQueueFullFromObj({ detail: "The request queue is full but wrong shape" }), null);
  assert.strictEqual(extractQueueFullFromObj(null), null);
});

test("finds queue-full inside SSE framing, with or without a space", () => {
  const payload = '{"error":{"message":"The request queue is full","code":503}}';
  assert.match(extractQueueFullMessage(`data: ${payload}\n\n`), /queue is full/);
  assert.match(extractQueueFullMessage(`data:${payload}\r\n\r\n`), /queue is full/);
  assert.strictEqual(extractQueueFullMessage("data: [DONE]\n\n"), null);
});

test("canonical 429 body matches the OpenAI schema", () => {
  const parsed = JSON.parse(buildRateLimitBody("full"));
  assert.strictEqual(parsed.error.type, "rate_limit_exceeded");
  assert.strictEqual(parsed.error.code, "rate_limit_exceeded");
  assert.strictEqual(parsed.error.param, null);
});

test("rewriteSSELine preserves framing and CR", () => {
  const line = 'data: {"error":{"message":"The request queue is full","code":503}}\r';
  const r = rewriteSSELine(line);
  assert.strictEqual(r.hit, true);
  assert.ok(r.line.startsWith("data: "));
  assert.ok(r.line.endsWith("\r"), "CR preserved");
  assert.match(r.line, /rate_limit_exceeded/);
});

test("rewriteSSELine passes normal chunks through untouched", () => {
  const line = 'data: {"choices":[{"delta":{"content":"hi"}}]}';
  const r = rewriteSSELine(line);
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.line, line);
  assert.ok(r.parsed, "still parsed, so stats can be collected");
});

test("collectStats reads usage, finish_reason and presence flags", () => {
  const stats = {};
  collectStats({ choices: [{ delta: { reasoning_content: "thinking" } }] }, stats, {});
  collectStats({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }, stats, {});
  collectStats({ usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 3 } }, stats, {});
  assert.strictEqual(stats.sawReasoning, true);
  assert.strictEqual(stats.sawContent, true);
  assert.strictEqual(stats.finishReason, "stop");
  assert.strictEqual(stats.promptTokens, 10);
  assert.strictEqual(stats.reasoningTokens, 3);
});

test("collectStats captures text only when asked", () => {
  const off = {};
  collectStats({ choices: [{ delta: { reasoning_content: "secret" } }] }, off, {});
  assert.strictEqual(off.reasoningText, undefined, "no text captured by default");

  const on = {};
  collectStats({ choices: [{ delta: { reasoning_content: "part1 " } }] }, on, { captureReasoning: true });
  collectStats({ choices: [{ delta: { reasoning_content: "part2" } }] }, on, { captureReasoning: true });
  assert.strictEqual(on.reasoningText, "part1 part2", "streamed deltas concatenated");
});

test("collectStats gathers tool_call ids for cache keys", () => {
  const stats = {};
  collectStats({ choices: [{ delta: { tool_calls: [
    { id: "call_a", function: { name: "read_file" } },
    { id: "call_b", function: { name: "bash" } },
  ] } }] }, stats, {});
  assert.deepStrictEqual([...stats.toolCallIds], ["call_a", "call_b"]);
  assert.deepStrictEqual(stats.toolNames, ["read_file", "bash"]);
});
