"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { DeadlockTracker, nudgeToolResult } = require("../../src/transform/nudge");

const NUDGE = "Think carefully about what to do next before responding.";

function agentBody(turns, lastRole = "tool") {
  const messages = [{ role: "user", content: "go" }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "assistant", content: null,
      tool_calls: [{ id: `t${i}`, type: "function", function: { name: "f", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `t${i}`, content: `result ${i}` });
  }
  if (lastRole === "user") messages.push({ role: "user", content: "now explain" });
  return { messages };
}

test("deadlock needs N consecutive empty responses", () => {
  const t = new DeadlockTracker({ consecutive: 3, maxSessions: 10 });
  t.record("s", 1);
  t.record("s", 1);
  assert.strictEqual(t.isDeadlocked("s"), false, "2 < 3");
  t.record("s", 1);
  assert.strictEqual(t.isDeadlocked("s"), true);
});

test("a single thinking response clears the streak", () => {
  const t = new DeadlockTracker({ consecutive: 3, maxSessions: 10 });
  t.record("s", 1); t.record("s", 1); t.record("s", 500);
  assert.strictEqual(t.isDeadlocked("s"), false);
});

test("sessions are tracked independently", () => {
  const t = new DeadlockTracker({ consecutive: 2, maxSessions: 10 });
  t.record("a", 1); t.record("a", 1);
  t.record("b", 800);
  assert.strictEqual(t.isDeadlocked("a"), true);
  assert.strictEqual(t.isDeadlocked("b"), false);
});

test("session history is LRU-bounded", () => {
  const t = new DeadlockTracker({ consecutive: 1, maxSessions: 2 });
  t.record("s1", 1); t.record("s2", 1); t.record("s3", 1);
  assert.strictEqual(t.isDeadlocked("s1"), false, "evicted");
  assert.strictEqual(t.isDeadlocked("s3"), true);
});

test("appends only when deadlocked and long enough", () => {
  const body = agentBody(20);
  assert.strictEqual(
    nudgeToolResult(body, { text: NUDGE, minTurns: 10, deadlocked: false }), false);
  assert.strictEqual(
    nudgeToolResult(body, { text: NUDGE, minTurns: 10, deadlocked: true }), true);
  assert.ok(body.messages.at(-1).content.endsWith(NUDGE));
  assert.ok(body.messages.at(-1).content.startsWith("result 19"), "tool output preserved");
});

test("a fresh session is never nudged", () => {
  const body = agentBody(3);
  assert.strictEqual(
    nudgeToolResult(body, { text: NUDGE, minTurns: 10, deadlocked: true }), false);
});

test("only applies when the last message is a tool result", () => {
  const body = agentBody(20, "user");
  assert.strictEqual(
    nudgeToolResult(body, { text: NUDGE, minTurns: 10, deadlocked: true }), false);
});

test("idempotent across retries", () => {
  const body = agentBody(20);
  nudgeToolResult(body, { text: NUDGE, minTurns: 10, deadlocked: true });
  nudgeToolResult(body, { text: NUDGE, minTurns: 10, deadlocked: true });
  const occurrences = body.messages.at(-1).content.split(NUDGE).length - 1;
  assert.strictEqual(occurrences, 1);
});

test("disabled when no text is configured", () => {
  const body = agentBody(20);
  assert.strictEqual(
    nudgeToolResult(body, { text: "", minTurns: 10, deadlocked: true }), false);
});
