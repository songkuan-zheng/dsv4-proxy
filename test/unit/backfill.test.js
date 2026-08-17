"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { backfillReasoning, findLastUserIndex } = require("../../src/transform/backfill");
const { ReasoningCache } = require("../../src/cache");
const { contentKey } = require("../../src/crypto");

function makeCache() {
  return new ReasoningCache({
    maxEntries: 100, maxBytes: 1 << 20, maxChars: 10000,
    key: null, redisUrl: "", ttlSec: 60, prefix: "t:",
  });
}
const OPTS = { maxTurns: 0, contentKeyChars: 512 };
const TOOLS = [{ type: "function", function: { name: "f" } }];

function toolTurn(id) {
  return [
    { role: "assistant", content: null,
      tool_calls: [{ id, type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: id, content: "out" },
  ];
}

test("findLastUserIndex counts only user/developer", () => {
  const msgs = [
    { role: "user", content: "a" },        // 0
    { role: "assistant", content: "b" },   // 1
    { role: "tool", content: "c" },        // 2  tool renders as <|User|> but must not count
  ];
  assert.strictEqual(findLastUserIndex(msgs), 0);
  msgs.push({ role: "developer", content: "d" });
  assert.strictEqual(findLastUserIndex(msgs), 3);
  assert.strictEqual(findLastUserIndex([{ role: "assistant" }]), -1);
});

test("repairs a turn keyed by tool_call_id", async () => {
  const cache = makeCache();
  cache.set(["t1"], "remembered reasoning");
  const body = { tools: TOOLS, messages: [{ role: "user", content: "go" }, ...toolTurn("t1")] };
  const { repaired } = await backfillReasoning(body, cache, OPTS);
  assert.strictEqual(repaired, 1);
  assert.strictEqual(body.messages[1].reasoning_content, "remembered reasoning");
});

test("repairs a turn that answered without calling a tool", async () => {
  // DeepSeek requires these too when the request carries tools; they have no id,
  // so they are keyed by a hash of their content.
  const cache = makeCache();
  const answer = "The race is between the check and the store.";
  cache.set([contentKey(answer, 512)], "reasoned about the race");
  const body = { tools: TOOLS, messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: answer },
  ]};
  const { repaired } = await backfillReasoning(body, cache, OPTS);
  assert.strictEqual(repaired, 1);
  assert.strictEqual(body.messages[1].reasoning_content, "reasoned about the race");
});

test("never overwrites reasoning the client kept", async () => {
  const cache = makeCache();
  cache.set(["t1"], "from cache");
  const body = { tools: TOOLS, messages: [
    { role: "user", content: "go" },
    { ...toolTurn("t1")[0], reasoning_content: "client's own" },
    toolTurn("t1")[1],
  ]};
  const { repaired } = await backfillReasoning(body, cache, OPTS);
  assert.strictEqual(repaired, 0);
  assert.strictEqual(body.messages[1].reasoning_content, "client's own");
});

test("cache miss leaves the message untouched", async () => {
  const cache = makeCache();
  const body = { tools: TOOLS, messages: [{ role: "user", content: "go" }, ...toolTurn("unknown")] };
  const { repaired } = await backfillReasoning(body, cache, OPTS);
  assert.strictEqual(repaired, 0);
  assert.ok(!("reasoning_content" in body.messages[1]));
});

test("with tools, turns before the last user are repaired", async () => {
  const cache = makeCache();
  cache.set(["early"], "early trace");
  const body = { tools: TOOLS, messages: [
    { role: "user", content: "first" },
    ...toolTurn("early"),
    { role: "user", content: "second" },
  ]};
  const { repaired } = await backfillReasoning(body, cache, OPTS);
  assert.strictEqual(repaired, 1, "drop_thinking=False server-side, so all turns render");
});

test("without tools, only turns after the last user are repaired", async () => {
  // Mirrors SGLang's _drop_thinking_messages: earlier reasoning is stripped
  // anyway, so repairing it is wasted prompt.
  const cache = makeCache();
  cache.set(["early"], "early trace");
  cache.set(["late"], "late trace");
  const body = { messages: [
    { role: "user", content: "first" },
    ...toolTurn("early"),
    { role: "user", content: "second" },
    ...toolTurn("late"),
  ]};
  const { repaired } = await backfillReasoning(body, cache, OPTS);
  assert.strictEqual(repaired, 1);
  const early = body.messages.find((m) => m.tool_calls && m.tool_calls[0].id === "early");
  const late = body.messages.find((m) => m.tool_calls && m.tool_calls[0].id === "late");
  assert.ok(!("reasoning_content" in early), "before last user: skipped");
  assert.strictEqual(late.reasoning_content, "late trace");
});

test("maxTurns keeps the turns nearest the end", async () => {
  const cache = makeCache();
  for (const id of ["a", "b", "c"]) cache.set([id], `trace ${id}`);
  const body = { tools: TOOLS, messages: [
    { role: "user", content: "go" }, ...toolTurn("a"), ...toolTurn("b"), ...toolTurn("c"),
  ]};
  const { repaired } = await backfillReasoning(body, cache, { ...OPTS, maxTurns: 1 });
  assert.strictEqual(repaired, 1);
  const byId = (id) => body.messages.find((m) => m.tool_calls && m.tool_calls[0].id === id);
  assert.strictEqual(byId("c").reasoning_content, "trace c", "newest repaired");
  assert.ok(!("reasoning_content" in byId("a")));
});
